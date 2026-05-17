/**
 * Prospect-01 — sources fresh contacts for a client based on the approved
 * playbook ICP. End-to-end flow:
 *
 *   1. Load the client's approved playbook.
 *   2. Translate the raw English ICP into Apollo + Hunter API params via
 *      `lib/icp-translator.ts`. Cached on the playbook row per version —
 *      normal runs make ZERO Claude calls.
 *   3. Apollo People Search with the translated params.
 *   4. Apollo bulk-enrichment for every search hit → contacts with email.
 *   5. For search hits Apollo couldn't enrich: call Hunter Email Finder
 *      using the contact's first/last name + organisation domain.
 *   6. Drop contacts still missing an email (Hunter returned 404).
 *   7. Dedup against existing leads (case-insensitive email).
 *   8. Insert remaining leads as `source='ai_enriched'`,
 *      `approval_status='pending_approval'`.
 *   9. Create a `lead_list` approval with the full funnel in payload so
 *      HOS can audit each stage.
 *
 * Re-run safe: dedup ensures repeated runs only insert what's new.
 */

import { createServiceClient } from "@/lib/supabase/server";
import { logEvent } from "@/lib/events";
import {
  ApolloApiError,
  ApolloConfigError,
  apolloKeyFingerprint,
  enrichPeople,
  searchPeople,
  type ApolloPersonFull,
  type ApolloPersonPartial,
} from "@/lib/apollo";
import {
  HunterApiError,
  HunterConfigError,
  findEmail as hunterFindEmail,
  hunterKeyFingerprint,
} from "@/lib/hunter";
import {
  getOrCreateSegmentTranslatedParams,
  getOrCreateTranslatedParams,
} from "@/lib/icp-translator";
import { applyRunToSegment } from "@/lib/segments";
import type {
  ICP,
  Playbook,
  PlaybookSegment,
  TranslatedApolloParams,
} from "@/lib/supabase/types";

export type ProspectFunnel = {
  /** People returned by Apollo search (pre-enrichment). */
  searched: number;
  /** Apollo search hits we sent to bulk_match for email enrichment. */
  enrichment_attempted: number;
  /** Apollo enrichment hits that came back with an email. */
  enriched_via_apollo: number;
  /** Hunter email-finder calls made for Apollo enrichment misses. */
  hunter_lookups_attempted: number;
  /** Hunter calls that returned an email (not 404). */
  enriched_via_hunter: number;
  /** People dropped because no provider could find their email. */
  missing_email: number;
  /** Email duplicates against existing leads, filtered. */
  duplicates: number;
  /** New rows inserted into the leads table. */
  new: number;
};

export type ProspectRunResult = {
  ok: true;
  client_id: string;
  funnel: ProspectFunnel;
  translated_params: TranslatedApolloParams;
  translation_cache_hit: boolean;
  approval_id: string | null;
  lead_ids: string[];
  /** Item 7 — present when the run targeted a specific segment. */
  segment_id?: string;
  segment_name?: string;
  segment_runs_completed?: number;
  segment_leads_remaining?: number;
};

export type ProspectRunFailure = {
  ok: false;
  error: string;
  config_error?: boolean;
};

export async function runProspect01(
  clientId: string,
  opts: { triggeredBy?: string; pageSize?: number; segmentId?: string } = {},
): Promise<ProspectRunResult | ProspectRunFailure> {
  const supabase = createServiceClient();

  console.log(
    `[prospect-01] start client=${clientId} segment=${opts.segmentId ?? "none"} apollo=${apolloKeyFingerprint()} hunter=${hunterKeyFingerprint()}`,
  );

  // 1. Load approved playbook
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

  // Item 7 — resolve the ICP to source against. If a segmentId was
  // supplied, use the segment's tighter ICP; otherwise fall back to the
  // playbook's catch-all ICP. Rejected / exhausted segments are gated.
  const allSegments = (playbook.segments ?? []) as PlaybookSegment[];
  let activeSegment: PlaybookSegment | null = null;
  if (opts.segmentId) {
    activeSegment = allSegments.find((s) => s.id === opts.segmentId) ?? null;
    if (!activeSegment) {
      return { ok: false, error: `Segment ${opts.segmentId} not found on the approved playbook.` };
    }
    if (activeSegment.status === "rejected") {
      return { ok: false, error: `Segment "${activeSegment.name}" was rejected — pick another.` };
    }
    if (activeSegment.status === "exhausted") {
      return { ok: false, error: `Segment "${activeSegment.name}" is exhausted (0 leads remaining).` };
    }
  }

  const icp: ICP = (activeSegment ? activeSegment.icp : playbook.icp) ?? {};

  if (!icp.target_titles?.length && !icp.industries?.length) {
    return {
      ok: false,
      error: "ICP needs at least one of: industries, target_titles. Tighten the playbook and retry.",
    };
  }

  // 2. Translate ICP (cached per playbook version). Segment ICPs cache
  //    onto the segment object inside playbook.segments[]; the catch-all
  //    ICP caches onto playbook.icp.translated_params.
  const { params: translated, cacheHit } = activeSegment
    ? await getOrCreateSegmentTranslatedParams({
        supabase,
        playbookId: playbook.id,
        segments: allSegments,
        segmentId: activeSegment.id,
        playbookVersion: playbook.version,
      })
    : await getOrCreateTranslatedParams({
        supabase,
        playbookId: playbook.id,
        icp,
        playbookVersion: playbook.version,
      });
  console.log(
    `[prospect-01] translation ${cacheHit ? "cache hit" : "cache miss — Claude called"} (version ${translated.version})`,
  );

  // 3. Apollo People Search
  let search: Awaited<ReturnType<typeof searchPeople>>;
  try {
    search = await searchPeople({
      ...translated.apollo,
      per_page: opts.pageSize ?? 50,
      page: 1,
      clientId,
    });
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
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }

  // 4. Apollo bulk enrichment
  const ids = search.people.map((p) => p.id).filter(Boolean);
  let enrichment: Awaited<ReturnType<typeof enrichPeople>>;
  try {
    enrichment = await enrichPeople(ids, { clientId });
  } catch (err) {
    return {
      ok: false,
      error:
        err instanceof ApolloApiError
          ? `Apollo enrichment failed (${err.status}): ${err.message}`
          : err instanceof Error
            ? err.message
            : String(err),
    };
  }

  // Stitch enriched contacts back onto their partial counterparts —
  // keeps the org domain handy if Apollo only returned it in the search
  // step (or only in the enrichment step). Build a map by id.
  const enrichedById = new Map<string, ApolloPersonFull>();
  for (const e of enrichment.enriched) enrichedById.set(e.id, e);

  const stitched: Array<ApolloPersonFull & { source: "apollo" | "hunter" }> = [];
  const hunterTargets: Array<{
    partial: ApolloPersonPartial;
    domain: string;
  }> = [];
  let hunterLookupsAttempted = 0;
  let enrichedViaHunter = 0;
  let missingEmail = 0;

  for (const partial of search.people) {
    const enriched = enrichedById.get(partial.id);
    const mergedOrg = {
      ...partial.organization,
      ...(enriched?.organization ?? {}),
    };
    const merged: ApolloPersonFull = {
      ...partial,
      ...(enriched ?? {}),
      organization: mergedOrg,
      email: enriched?.email ?? null,
      email_status: enriched?.email_status ?? null,
    };

    if (merged.email) {
      stitched.push({ ...merged, source: "apollo" });
      continue;
    }

    // No Apollo email — try Hunter if we have enough to call it.
    const domain = merged.organization.domain;
    const first = merged.first_name;
    const last = merged.last_name;
    if (
      process.env.HUNTER_API_KEY &&
      domain &&
      first &&
      last
    ) {
      hunterTargets.push({ partial: merged, domain });
    } else {
      missingEmail++;
    }
  }

  // 5. Hunter email-finder for misses
  for (const t of hunterTargets) {
    if (!t.partial.first_name || !t.partial.last_name) {
      missingEmail++;
      continue;
    }
    hunterLookupsAttempted++;
    try {
      const found = await hunterFindEmail({
        domain: t.domain,
        first_name: t.partial.first_name,
        last_name: t.partial.last_name,
        clientId,
      });
      if (found) {
        enrichedViaHunter++;
        stitched.push({
          ...(t.partial as ApolloPersonFull),
          email: found.email,
          email_status: found.verification_status,
          source: "hunter",
        });
      } else {
        missingEmail++;
      }
    } catch (err) {
      if (err instanceof HunterConfigError) {
        // No key — shouldn't happen since we guarded above. Count as miss.
        missingEmail++;
      } else if (err instanceof HunterApiError) {
        // Hard error from Hunter — log and treat as miss; don't fail the whole run.
        console.warn(`[prospect-01] hunter error for ${t.domain}/${t.partial.first_name} ${t.partial.last_name}:`, err.message);
        missingEmail++;
      } else {
        console.warn(`[prospect-01] hunter call threw for ${t.domain}:`, err);
        missingEmail++;
      }
    }
  }

  // 7. Dedup against existing leads (case-insensitive email)
  const candidateEmails = stitched
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

  const seenInBatch = new Set<string>();
  const toInsert = stitched
    .filter((c) => {
      if (!c.email) return false;
      const e = c.email.toLowerCase();
      if (existingEmails.has(e) || seenInBatch.has(e)) return false;
      seenInBatch.add(e);
      return true;
    })
    .map((c) => ({
      client_id: clientId,
      company_name: c.organization.name ?? "Unknown company",
      contact_name: [c.first_name, c.last_name].filter(Boolean).join(" ") || null,
      title: c.title,
      email: c.email,
      industry: c.organization.industry,
      website: c.organization.website ?? c.organization.domain,
      employees_estimate: parseEmployees(c.organization.size),
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

  const duplicates = stitched.filter((c) => c.email).length - insertedLeadIds.length;
  const funnel: ProspectFunnel = {
    searched: search.people.length,
    enrichment_attempted: enrichment.attempted,
    enriched_via_apollo: enrichment.with_email,
    hunter_lookups_attempted: hunterLookupsAttempted,
    enriched_via_hunter: enrichedViaHunter,
    missing_email: missingEmail,
    duplicates,
    new: insertedLeadIds.length,
  };

  // 9. Create lead_list approval (only if we sourced new leads)
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

    const summary = buildApprovalSummary(funnel, campaign);

    const titleSuffix = activeSegment ? ` (${activeSegment.name})` : "";
    const { data: appr, error: apprErr } = await supabase
      .from("approvals")
      .insert({
        client_id: clientId,
        type: "lead_list",
        status: "pending",
        title: `Prospect-01 sourced ${funnel.new} new leads${titleSuffix}`,
        summary,
        payload: {
          lead_ids: insertedLeadIds,
          source: "prospect-01",
          campaign_id: campaign?.id ?? null,
          funnel,
          translated_params: translated.apollo,
          translation_cache_hit: cacheHit,
          segment_id: activeSegment?.id ?? null,
          segment_name: activeSegment?.name ?? null,
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

  // Item 7 — when this run targeted a specific segment, record a
  // segment_runs row + decrement leads_remaining on the segment. Mark
  // the segment as `exhausted` if the pool now sits at <= 0. Best-effort
  // — failures here don't abort the run.
  let segmentRunsCompleted: number | undefined;
  let segmentLeadsRemaining: number | undefined;
  if (activeSegment) {
    const sourced = insertedLeadIds.length;
    const delta = applyRunToSegment(activeSegment, sourced);

    await supabase.from("segment_runs").insert({
      client_id: clientId,
      playbook_id: playbook.id,
      segment_id: activeSegment.id,
      leads_sourced: sourced,
      leads_remaining: delta.leads_remaining,
      ran_by: opts.triggeredBy ?? null,
    });

    const nextSegments = allSegments.map((s) =>
      s.id === activeSegment!.id
        ? {
            ...s,
            runs_completed: delta.runs_completed,
            leads_remaining: delta.leads_remaining,
            status: delta.status,
          }
        : s,
    );
    await supabase.from("playbooks").update({ segments: nextSegments }).eq("id", playbook.id);

    segmentRunsCompleted = delta.runs_completed;
    segmentLeadsRemaining = delta.leads_remaining;
  }

  await logEvent({
    service: true,
    event_type: "ai_action",
    client_id: clientId,
    user_id: opts.triggeredBy ?? null,
    payload: {
      kind: "prospect_run",
      funnel,
      translated_params: translated.apollo,
      translation_cache_hit: cacheHit,
      approval_id: approvalId,
      segment_id: activeSegment?.id ?? null,
      segment_name: activeSegment?.name ?? null,
      segment_runs_completed: segmentRunsCompleted ?? null,
      segment_leads_remaining: segmentLeadsRemaining ?? null,
    },
  });

  return {
    ok: true,
    client_id: clientId,
    funnel,
    translated_params: translated.apollo,
    translation_cache_hit: cacheHit,
    approval_id: approvalId,
    lead_ids: insertedLeadIds,
    segment_id: activeSegment?.id,
    segment_name: activeSegment?.name,
    segment_runs_completed: segmentRunsCompleted,
    segment_leads_remaining: segmentLeadsRemaining,
  };
}

function buildApprovalSummary(
  funnel: ProspectFunnel,
  campaign: { id: string; name: string } | null,
): string {
  return [
    `Apollo search matched ${funnel.searched} people; enrichment returned ${funnel.enriched_via_apollo} with email.`,
    `Hunter found ${funnel.enriched_via_hunter} more emails on ${funnel.hunter_lookups_attempted} lookups.`,
    `${funnel.missing_email} dropped (no email findable). ${funnel.duplicates} duplicates filtered.`,
    campaign
      ? `Will enrol into ${campaign.name} on approve.`
      : "No campaign attached — pick one at approval time.",
  ].join(" ");
}

function parseEmployees(input: string | null): number | null {
  if (!input) return null;
  const m = input.match(/(\d+)/);
  return m ? parseInt(m[1], 10) : null;
}
