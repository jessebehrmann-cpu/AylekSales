"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { requireUser } from "@/lib/auth";
import { logEvent } from "@/lib/events";
import { actionError, type ActionResult } from "@/lib/actions";
import type { Database } from "@/lib/supabase/types";

type LeadInsert = Database["public"]["Tables"]["leads"]["Insert"];

const Row = z.record(z.string().nullish());
const ImportInput = z.object({
  client_id: z.string().uuid().nullable(),
  rows: z.array(Row).min(1).max(2000),
});

/**
 * Receives already-mapped lead rows (keys matching our schema fields), inserts
 * them, dedupes by case-insensitive email match within the same client. Returns
 * counts so the UI can summarise.
 */
export async function commitLeadImport(payload: unknown): Promise<ActionResult<{ inserted: number; skipped: number }>> {
  try {
    const user = await requireUser();
    const parsed = ImportInput.safeParse(payload);
    if (!parsed.success) return { ok: false, error: "Invalid payload" };
    const { client_id, rows } = parsed.data;

    const supabase = createClient();

    // Collect emails for dedupe
    const emails = rows
      .map((r) => (typeof r.email === "string" ? r.email.trim().toLowerCase() : ""))
      .filter(Boolean);

    let existing = new Set<string>();
    if (emails.length > 0) {
      let q = supabase.from("leads").select("email").in("email", emails);
      if (client_id) q = q.eq("client_id", client_id);
      const { data: existingLeads } = await q;
      existing = new Set(
        (existingLeads ?? [])
          .map((l: { email: string | null }) => l.email?.toLowerCase())
          .filter((e): e is string => !!e),
      );
    }

    const toInsert: LeadInsert[] = [];
    let skipped = 0;

    for (const row of rows) {
      const company = (typeof row.company_name === "string" ? row.company_name : "").trim();
      if (!company) {
        skipped++;
        continue;
      }
      const email = typeof row.email === "string" ? row.email.trim().toLowerCase() : null;
      if (email && existing.has(email)) {
        skipped++;
        continue;
      }
      if (email) existing.add(email); // dedupe within the batch too

      toInsert.push({
        client_id,
        company_name: company,
        contact_name: nullish(row.contact_name),
        title: nullish(row.title),
        email,
        phone: nullish(row.phone),
        suburb: nullish(row.suburb),
        industry: nullish(row.industry),
        employees_estimate: parseIntOrNull(row.employees_estimate),
        website: nullish(row.website),
        source: "import",
        approval_status: "approved",
      });
    }

    if (toInsert.length === 0) {
      return { ok: true, inserted: 0, skipped };
    }

    const { data: inserted, error } = await supabase
      .from("leads")
      .insert(toInsert)
      .select("id, company_name");

    if (error) return { ok: false, error: error.message };

    // Bulk events — one row per insert. Best-effort.
    if (inserted) {
      const eventRows = inserted.map((l: { id: string; company_name: string }) => ({
        event_type: "lead_imported" as const,
        lead_id: l.id,
        client_id,
        user_id: user.auth.id,
        payload: { kind: "csv_import", lead_name: l.company_name },
      }));
      await supabase.from("events").insert(eventRows);
    }

    await logEvent({
      event_type: "ai_action",
      client_id,
      user_id: user.auth.id,
      payload: {
        kind: "csv_import_summary",
        inserted: inserted?.length ?? 0,
        skipped,
        total_rows: rows.length,
      },
    });

    revalidatePath("/leads");
    revalidatePath("/dashboard");
    return { ok: true, inserted: inserted?.length ?? 0, skipped };
  } catch (err) {
    return actionError(err);
  }
}

function nullish(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t === "" ? null : t;
}

function parseIntOrNull(v: unknown): number | null {
  if (v == null || v === "") return null;
  const n = parseInt(String(v).replace(/[^\d-]/g, ""), 10);
  return Number.isFinite(n) ? n : null;
}
