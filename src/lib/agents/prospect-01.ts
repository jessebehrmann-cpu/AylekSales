/**
 * Prospect-01 — sources fresh contacts via Apollo.io based on the client's
 * approved playbook ICP, dedupes against existing leads, writes new leads
 * with source='ai_enriched' + approval_status='pending_approval', and creates
 * a lead_list approval row for the HOS to review.
 *
 * Re-run safe: rate-limited by Apollo + dedup, so calling twice in a row
 * just inserts whatever's new since last time.
 */

import { createServiceClient } from "@/lib/supabase/server";
import { logEvent } from "@/lib/events";
import {
  ApolloApiError,
  ApolloConfigError,
  searchApolloContacts,
  type ApolloContact,
  type ApolloSearchFilter,
} from "@/lib/apollo";
import type { ICP, Playbook } from "@/lib/supabase/types";

export type ProspectRunResult = {
  ok: true;
  client_id: string;
  found: number;
  new: number;
  duplicates: number;
  approval_id: string | null;
  lead_ids: string[];
};

export type ProspectRunFailure = {
  ok: false;
  error: string;
  /** True when the failure is a missing/invalid API key, so callers can
   *  surface a clearer "configure Apollo" message vs a runtime error. */
  config_error?: boolean;
};

export async function runProspect01(
  clientId: string,
  opts: { triggeredBy?: string; pageSize?: number } = {},
): Promise<ProspectRunResult | ProspectRunFailure> {
  const supabase = createServiceClient();

  // 1. Find the client's approved playbook + read ICP
  const { data: pb } = await supabase
    .from("playbooks")
    .select("*")
    .eq("client_id", clientId)
    .eq("status", "approved")
    .maybeSingle();
  if (!pb) {
    return {
      ok: false,
      error: "Client has no approved playbook — Prospect-01 needs an ICP to source against.",
    };
  }
  const playbook = pb as Playbook;
  const icp = (playbook.icp ?? {}) as ICP;

  // 2. Build Apollo filter
  const filter = buildFilter(icp, opts.pageSize ?? 50);
  if (!filter.industries?.length && !filter.titles?.length) {
    return {
      ok: false,
      error: "ICP needs at least one of: industries, target_titles. Tighten the playbook and retry.",
    };
  }

  // 3. Call Apollo
  let contacts: ApolloContact[];
  try {
    const result = await searchApolloContacts(filter);
    contacts = result.contacts;
  } catch (err) {
    if (err instanceof ApolloConfigError) {
      return { ok: false, error: err.message, config_error: true };
    }
    if (err instanceof ApolloApiError) {
      return {
        ok: false,
        error: `Apollo API error (${err.status}): ${err.message}${err.body ? ` — ${err.body.slice(0, 200)}` : ""}`,
      };
    }
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }

  // 4. Dedup against existing leads (by email, case-insensitive)
  const candidateEmails = contacts
    .map((c) => c.email?.trim().toLowerCase())
    .filter((e): e is string => !!e);

  const existingEmails = new Set<string>();
  if (candidateEmails.length > 0) {
    const { data: existing } = await supabase
      .from("leads")
      .select("email")
      .in("email", candidateEmails);
    for (const row of (existing ?? []) as Array<{ email: string | null }>) {
      if (row.email) existingEmails.add(row.email.toLowerCase());
    }
  }

  // 5. Build inserts — only contacts with an email (so the send loop can use them)
  const seenInBatch = new Set<string>();
  const toInsert = contacts
    .filter((c) => {
      if (!c.email) return false;
      const e = c.email.toLowerCase();
      if (existingEmails.has(e) || seenInBatch.has(e)) return false;
      seenInBatch.add(e);
      return true;
    })
    .map((c) => ({
      client_id: clientId,
      company_name: c.company.name ?? "Unknown company",
      contact_name:
        [c.first_name, c.last_name].filter(Boolean).join(" ") || null,
      title: c.title,
      email: c.email,
      industry: c.company.industry,
      website: c.company.website ?? c.company.domain,
      employees_estimate: parseEmployees(c.company.size),
      source: "ai_enriched" as const,
      stage: "new" as const,
      approval_status: "pending_approval" as const,
    }));

  let insertedLeadIds: string[] = [];
  if (toInsert.length > 0) {
    const { data: inserted, error } = await supabase
      .from("leads")
      .insert(toInsert)
      .select("id");
    if (error) {
      return { ok: false, error: `Lead insert failed: ${error.message}` };
    }
    insertedLeadIds = (inserted ?? []).map((r: { id: string }) => r.id);
  }

  const duplicates = contacts.length - insertedLeadIds.length - (contacts.length - candidateEmails.length);

  // 6. Create lead_list approval (only if we found new leads)
  let approvalId: string | null = null;
  if (insertedLeadIds.length > 0) {
    // Try to attach to the client's most recent active campaign, if any.
    const { data: existingCampaign } = await supabase
      .from("campaigns")
      .select("id, name")
      .eq("client_id", clientId)
      .neq("status", "complete")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    const campaign = existingCampaign as { id: string; name: string } | null;

    const { data: appr, error: apprErr } = await supabase
      .from("approvals")
      .insert({
        client_id: clientId,
        type: "lead_list",
        status: "pending",
        title: `Prospect-01 sourced ${insertedLeadIds.length} new leads`,
        summary: `Sourced via Apollo against the approved ICP. ${duplicates} duplicate(s) filtered.${campaign ? ` Will enrol into ${campaign.name} on approve.` : " No campaign attached — pick one at approval time."}`,
        payload: {
          lead_ids: insertedLeadIds,
          source: "prospect-01",
          campaign_id: campaign?.id ?? null,
          apollo: {
            filter,
          },
        },
        related_campaign_id: campaign?.id ?? null,
        created_by: opts.triggeredBy ?? null,
      })
      .select("id")
      .single();
    if (apprErr || !appr) {
      return { ok: false, error: `Approval create failed: ${apprErr?.message ?? "unknown"}` };
    }
    approvalId = appr.id;
  }

  await logEvent({
    service: true,
    event_type: "ai_action",
    client_id: clientId,
    user_id: opts.triggeredBy ?? null,
    payload: {
      kind: "prospect_run",
      found: contacts.length,
      new: insertedLeadIds.length,
      duplicates,
      approval_id: approvalId,
    },
  });

  return {
    ok: true,
    client_id: clientId,
    found: contacts.length,
    new: insertedLeadIds.length,
    duplicates,
    approval_id: approvalId,
    lead_ids: insertedLeadIds,
  };
}

function buildFilter(icp: ICP, pageSize: number): ApolloSearchFilter {
  return {
    industries: icp.industries?.length ? icp.industries : undefined,
    titles: icp.target_titles?.length ? icp.target_titles : undefined,
    locations: icp.geography?.length ? icp.geography : undefined,
    companySize: parseCompanySize(icp.company_size),
    pageSize,
  };
}

/** Parse strings like "20–500 employees" / "50-1000" / "100+" into a band. */
function parseCompanySize(input: string | undefined): { min?: number; max?: number } | undefined {
  if (!input) return undefined;
  const cleaned = input.replace(/employees?/i, "").trim();
  const m = cleaned.match(/(\d+)\s*[\-–to]+\s*(\d+)/i);
  if (m) return { min: parseInt(m[1], 10), max: parseInt(m[2], 10) };
  const plus = cleaned.match(/(\d+)\+/);
  if (plus) return { min: parseInt(plus[1], 10) };
  const just = cleaned.match(/^(\d+)$/);
  if (just) return { min: parseInt(just[1], 10), max: parseInt(just[1], 10) };
  return undefined;
}

function parseEmployees(input: string | null): number | null {
  if (!input) return null;
  const m = input.match(/(\d+)/);
  return m ? parseInt(m[1], 10) : null;
}
