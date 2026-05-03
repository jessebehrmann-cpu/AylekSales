"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { requireUser } from "@/lib/auth";
import { logEvent } from "@/lib/events";
import { actionError, type ActionResult } from "@/lib/actions";
import type { LeadStage } from "@/lib/supabase/types";

const STAGES = [
  "new",
  "contacted",
  "replied",
  "meeting_booked",
  "quoted",
  "won",
  "lost",
  "unsubscribed",
] as const;

const optStr = z
  .preprocess((v) => (v === "" || v == null ? undefined : v), z.string().optional());
const optNum = z
  .preprocess((v) => (v === "" || v == null ? undefined : v), z.coerce.number().optional());

const LeadSchema = z.object({
  client_id: z.preprocess((v) => (v === "" || v == null ? undefined : v), z.string().uuid().optional()),
  company_name: z.string().min(1, "Company is required").max(200),
  contact_name: optStr,
  title: optStr,
  email: z.preprocess((v) => (v === "" || v == null ? undefined : v), z.string().email().optional()),
  phone: optStr,
  suburb: optStr,
  industry: optStr,
  employees_estimate: optNum,
  website: optStr,
  contract_value: optNum,
  notes: optStr,
});

function blankToNull<T extends Record<string, unknown>>(o: T): T {
  const out = { ...o };
  for (const k of Object.keys(out)) {
    if (out[k] === "" || out[k] === undefined) (out as Record<string, unknown>)[k] = null;
  }
  return out;
}

export async function createLead(formData: FormData): Promise<ActionResult<{ id: string }>> {
  try {
    const user = await requireUser();
    const parsed = LeadSchema.safeParse(Object.fromEntries(formData));
    if (!parsed.success) {
      return { ok: false, error: parsed.error.issues.map((i) => i.message).join("; ") };
    }
    const data = blankToNull(parsed.data);
    const supabase = createClient();

    const { data: row, error } = await supabase
      .from("leads")
      .insert({ ...data, source: "manual" })
      .select("id, company_name, client_id")
      .single();

    if (error || !row) return { ok: false, error: error?.message ?? "Insert failed" };

    await logEvent({
      event_type: "lead_imported",
      lead_id: row.id,
      client_id: row.client_id,
      user_id: user.auth.id,
      payload: { kind: "manual_create", lead_name: row.company_name },
    });

    revalidatePath("/leads");
    return { ok: true, id: row.id };
  } catch (err) {
    return actionError(err);
  }
}

export async function updateLeadStage(leadId: string, stage: LeadStage): Promise<ActionResult> {
  try {
    if (!STAGES.includes(stage)) return { ok: false, error: "Invalid stage" };
    const user = await requireUser();
    const supabase = createClient();

    const { data: before } = await supabase
      .from("leads")
      .select("stage, company_name, client_id")
      .eq("id", leadId)
      .maybeSingle();

    if (!before) return { ok: false, error: "Lead not found" };

    const { error } = await supabase
      .from("leads")
      .update({
        stage,
        last_contacted_at: stage === "contacted" ? new Date().toISOString() : undefined,
      })
      .eq("id", leadId);

    if (error) return { ok: false, error: error.message };

    await logEvent({
      event_type: "stage_changed",
      lead_id: leadId,
      client_id: before.client_id,
      user_id: user.auth.id,
      payload: { lead_name: before.company_name, before: before.stage, after: stage },
    });

    revalidatePath("/leads");
    revalidatePath(`/leads/${leadId}`);
    revalidatePath("/dashboard");
    return { ok: true };
  } catch (err) {
    return actionError(err);
  }
}

export async function addLeadNote(leadId: string, note: string): Promise<ActionResult> {
  try {
    if (!note.trim()) return { ok: false, error: "Note is empty" };
    const user = await requireUser();
    const supabase = createClient();

    const { data: lead } = await supabase
      .from("leads")
      .select("notes, company_name, client_id")
      .eq("id", leadId)
      .maybeSingle();
    if (!lead) return { ok: false, error: "Lead not found" };

    const stamp = new Date().toISOString();
    const appended = lead.notes
      ? `${lead.notes}\n\n— ${stamp}\n${note.trim()}`
      : `— ${stamp}\n${note.trim()}`;

    const { error } = await supabase.from("leads").update({ notes: appended }).eq("id", leadId);
    if (error) return { ok: false, error: error.message };

    await logEvent({
      event_type: "note_added",
      lead_id: leadId,
      client_id: lead.client_id,
      user_id: user.auth.id,
      payload: { lead_name: lead.company_name, note: note.trim().slice(0, 200) },
    });

    revalidatePath(`/leads/${leadId}`);
    return { ok: true };
  } catch (err) {
    return actionError(err);
  }
}

export async function deleteLead(leadId: string): Promise<ActionResult> {
  try {
    const user = await requireUser();
    const supabase = createClient();

    const { data: lead } = await supabase
      .from("leads")
      .select("company_name, client_id")
      .eq("id", leadId)
      .maybeSingle();

    const { error } = await supabase.from("leads").delete().eq("id", leadId);
    if (error) return { ok: false, error: error.message };

    await logEvent({
      event_type: "ai_action",
      client_id: lead?.client_id ?? null,
      user_id: user.auth.id,
      payload: { kind: "lead_deleted", lead_name: lead?.company_name },
    });

    revalidatePath("/leads");
    return { ok: true };
  } catch (err) {
    return actionError(err);
  }
}

export async function deleteLeadAndRedirect(leadId: string): Promise<void> {
  await deleteLead(leadId);
  redirect("/leads");
}
