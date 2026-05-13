/**
 * Prospect-01 — sources fresh contacts for a client based on the approved
 * playbook ICP, dedupes against existing leads, writes new leads with
 * source='ai_enriched' + approval_status='pending_approval', and creates a
 * lead_list approval row for the HOS to review.
 *
 * Two providers are supported, abstracted behind `lib/agents/providers.ts`:
 *   - Apollo.io (industry/title-driven; two-step search → enrich for emails)
 *   - Hunter.io (domain-driven; needs `icp.target_domains` in the playbook)
 *
 * Provider resolution rules (from `resolveProviders()`):
 *   APOLLO_API_KEY ∧ HUNTER_API_KEY → Apollo primary, Hunter fallback
 *   APOLLO_API_KEY only             → Apollo only
 *   HUNTER_API_KEY only             → Hunter only
 *   neither                          → config_error
 *
 * Fallback is automatic when the primary returns 403 / 429 / 5xx. Every
 * approval row carries `payload.provider` + `payload.funnel` so HOS can
 * see exactly which provider sourced the batch and where contacts were
 * lost.
 *
 * Re-run safe: dedup against existing leads, so calling twice in a row
 * just inserts whatever's new since last time.
 */

import { createServiceClient } from "@/lib/supabase/server";
import { logEvent } from "@/lib/events";
import type { ApolloSearchFilter } from "@/lib/apollo";
import {
  resolveProviders,
  runProvider,
  shouldFallback,
  type NormalizedContact,
  type ProviderName,
  type ProviderRunResult,
} from "@/lib/agents/providers";
import type { ICP, Playbook } from "@/lib/supabase/types";

export type ProspectRunResult = {
  ok: true;
  client_id: string;
  /** Which provider produced the contacts in this batch. */
  provider_used: ProviderName;
  /** Provider-specific funnel counts (searched_total / enrichment_attempted
   *  / enriched_with_email for Apollo; searched_domains / domains_with_emails
   *  / total_emails_returned for Hunter). */
  funnel: Record<string, number>;
  /** Number of contacts the provider returned with a usable email
   *  (pre-dedup). Equivalent to `funnel.enriched_with_email` for Apollo
   *  and `funnel.total_emails_returned` for Hunter (post-filter). */
  found: number;
  /** New leads inserted into the DB after dedup. */
  new: number;
  /** Contacts dropped because the email was already in our leads table. */
  duplicates: number;
  approval_id: string | null;
  lead_ids: string[];
};

export type ProspectRunFailure = {
  ok: false;
  error: string;
  /** True when the failure is a missing/invalid API key, so callers can
   *  surface a clearer "configure the provider" message vs a runtime error. */
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

  // 2. Resolve providers from env
  const cfg = resolveProviders();
  if (!cfg.primary) {
    return {
      ok: false,
      error:
        "No prospecting provider configured. Set APOLLO_API_KEY and/or HUNTER_API_KEY to enable Prospect-01.",
      config_error: true,
    };
  }

  // 3. Build the Apollo filter once (cheap; Hunter ignores it but
  //    consumes icp.target_titles + icp.target_domains directly).
  const apolloFilter = buildApolloFilter(icp, opts.pageSize ?? 50);
  const hunterRequiresDomains = cfg.primary === "hunter" || cfg.fallback === "hunter";
  if (
    cfg.primary === "apollo" &&
    !apolloFilter.industries?.length &&
    !apolloFilter.titles?.length &&
    !hunterRequiresDomains
  ) {
    return {
      ok: false,
      error: "ICP needs at least one of: industries, target_titles. Tighten the playbook and retry.",
    };
  }

  // 4. Run the primary; on a fallback-eligible failure, retry with the
  //    secondary. Other failures surface as-is.
  let providerResult: ProviderRunResult = await runProvider(
    cfg.primary,
    apolloFilter,
    icp,
  );
  let fellBackFrom: ProviderName | null = null;
  if (!providerResult.ok && cfg.fallback && shouldFallback(providerResult.error)) {
    console.log(
      `[prospect-01] ${cfg.primary} failed (${providerResult.error.slice(0, 120)}) — falling back to ${cfg.fallback}`,
    );
    fellBackFrom = cfg.primary;
    providerResult = await runProvider(cfg.fallback, apolloFilter, icp);
  }

  if (!providerResult.ok) {
    return {
      ok: false,
      error: providerResult.error,
      config_error: providerResult.config_error,
    };
  }

  const providerUsed = providerResult.provider;
  const funnel = providerResult.funnel;
  const contacts = providerResult.contacts;

  // 5. Dedup against existing leads (by email, case-insensitive)
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

  // 6. Build inserts — only contacts with an email (so the send loop can use them)
  const seenInBatch = new Set<string>();
  const toInsert = contacts
    .filter((c) => {
      if (!c.email) return false;
      const e = c.email.toLowerCase();
      if (existingEmails.has(e) || seenInBatch.has(e)) return false;
      seenInBatch.add(e);
      return true;
    })
    .map((c) => leadInsertFromContact(clientId, c));

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

  const duplicates = contacts.length - insertedLeadIds.length;

  // 7. Create lead_list approval (only if we sourced new leads)
  let approvalId: string | null = null;
  if (insertedLeadIds.length > 0) {
    const { data: existingCampaign } = await supabase
      .from("campaigns")
      .select("id, name")
      .eq("client_id", clientId)
      .neq("status", "complete")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    const campaign = existingCampaign as { id: string; name: string } | null;

    const summary = buildApprovalSummary({
      providerUsed,
      fellBackFrom,
      funnel,
      duplicates,
      campaign,
    });

    const { data: appr, error: apprErr } = await supabase
      .from("approvals")
      .insert({
        client_id: clientId,
        type: "lead_list",
        status: "pending",
        title: `Prospect-01 sourced ${insertedLeadIds.length} new leads (via ${providerUsed})`,
        summary,
        payload: {
          lead_ids: insertedLeadIds,
          source: "prospect-01",
          campaign_id: campaign?.id ?? null,
          provider: providerUsed,
          fell_back_from: fellBackFrom,
          funnel,
          apollo: { filter: apolloFilter },
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
      provider_used: providerUsed,
      fell_back_from: fellBackFrom,
      funnel,
      found: contacts.length,
      new: insertedLeadIds.length,
      duplicates,
      approval_id: approvalId,
    },
  });

  return {
    ok: true,
    client_id: clientId,
    provider_used: providerUsed,
    funnel,
    found: contacts.length,
    new: insertedLeadIds.length,
    duplicates,
    approval_id: approvalId,
    lead_ids: insertedLeadIds,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────

function leadInsertFromContact(clientId: string, c: NormalizedContact) {
  return {
    client_id: clientId,
    company_name: c.company.name ?? "Unknown company",
    contact_name: [c.first_name, c.last_name].filter(Boolean).join(" ") || null,
    title: c.title,
    email: c.email,
    industry: c.company.industry,
    website: c.company.website ?? c.company.domain,
    employees_estimate: parseEmployees(c.company.size),
    source: "ai_enriched" as const,
    stage: "new" as const,
    approval_status: "pending_approval" as const,
  };
}

function buildApprovalSummary(args: {
  providerUsed: ProviderName;
  fellBackFrom: ProviderName | null;
  funnel: Record<string, number>;
  duplicates: number;
  campaign: { id: string; name: string } | null;
}): string {
  const { providerUsed, fellBackFrom, funnel, duplicates, campaign } = args;
  const parts: string[] = [];
  if (fellBackFrom) {
    parts.push(
      `${fellBackFrom} returned an error → fell back to ${providerUsed}.`,
    );
  }
  if (providerUsed === "apollo") {
    parts.push(
      `Apollo search matched ${funnel.searched_total ?? 0} people; enrichment returned ${funnel.enriched_with_email ?? 0} with email (${(funnel.enrichment_attempted ?? 0) - (funnel.enriched_with_email ?? 0)} had no usable email).`,
    );
  } else {
    parts.push(
      `Hunter searched ${funnel.searched_domains ?? 0} domains; ${funnel.domains_with_emails ?? 0} returned at least one email (${funnel.total_emails_returned ?? 0} emails total before title filter).`,
    );
  }
  parts.push(`${duplicates} duplicate(s) filtered against existing leads.`);
  parts.push(
    campaign
      ? `Will enrol into ${campaign.name} on approve.`
      : "No campaign attached — pick one at approval time.",
  );
  return parts.join(" ");
}

function buildApolloFilter(icp: ICP, pageSize: number): ApolloSearchFilter {
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
