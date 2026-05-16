/**
 * Per-client usage + cost tracking.
 *
 * Every upstream API call logs a `usage_events` row. The numbers feed
 * the /clients/[id]/usage dashboard + nightly cap alerts (Phase 7).
 *
 * Cost estimation:
 *   - Apollo people search: free (no credits consumed).
 *   - Apollo bulk_match: paid; assume $0.10 per enriched contact
 *     (configurable via APOLLO_ENRICHMENT_COST_CENTS).
 *   - Hunter email-finder: 1 search credit per successful match (free
 *     on 404). Free-tier plan: 25/mo; treat each successful call as
 *     ~$0.10 amortised (configurable).
 *   - Anthropic: priced per token. Use the model output's
 *     usage.input_tokens + usage.output_tokens × per-model rates
 *     baked in below. Rates are best-effort estimates — accurate
 *     billing comes from your Anthropic console.
 *   - Resend: 1 send = 1 unit. Pricing depends on plan; default 0.
 *
 * Failures here NEVER fail the caller — usage tracking is fire-and-
 * forget and best-effort.
 */

import { createServiceClient } from "@/lib/supabase/server";

export type UsageKind =
  | "apollo.search"
  | "apollo.bulk_match"
  | "hunter.email_finder"
  | "hunter.account"
  | "anthropic.messages"
  | "resend.send";

const APOLLO_ENRICHMENT_COST_CENTS = Number(
  process.env.APOLLO_ENRICHMENT_COST_CENTS ?? "10",
);
const HUNTER_FINDER_COST_CENTS = Number(
  process.env.HUNTER_FINDER_COST_CENTS ?? "10",
);

// Anthropic pricing (per 1M tokens) — best effort, override via env.
// Defaults reflect Sonnet 4.6 pricing as of mid-2026.
const ANTHROPIC_INPUT_USD_PER_MTOK = Number(
  process.env.ANTHROPIC_INPUT_USD_PER_MTOK ?? "3",
);
const ANTHROPIC_OUTPUT_USD_PER_MTOK = Number(
  process.env.ANTHROPIC_OUTPUT_USD_PER_MTOK ?? "15",
);

export type UsageRecord = {
  clientId: string | null;
  kind: UsageKind;
  units?: number;
  costCents?: number;
  payload?: Record<string, unknown>;
};

/** Fire-and-forget. */
export function recordUsage(rec: UsageRecord): void {
  void writeUsage(rec).catch((err) => {
    console.warn(`[usage] failed to record ${rec.kind}`, err);
  });
}

async function writeUsage(rec: UsageRecord): Promise<void> {
  const supabase = createServiceClient();
  await supabase.from("usage_events").insert({
    client_id: rec.clientId,
    kind: rec.kind,
    units: rec.units ?? 1,
    cost_cents: rec.costCents ?? 0,
    payload: (rec.payload ?? {}) as never,
  });
}

/** Cost estimator for Anthropic from a Messages API response usage block. */
export function anthropicCostCents(usage: {
  input_tokens?: number;
  output_tokens?: number;
}): number {
  const input = usage.input_tokens ?? 0;
  const output = usage.output_tokens ?? 0;
  const cents =
    (input / 1_000_000) * ANTHROPIC_INPUT_USD_PER_MTOK * 100 +
    (output / 1_000_000) * ANTHROPIC_OUTPUT_USD_PER_MTOK * 100;
  return Math.round(cents);
}

export function apolloEnrichmentCostCents(unitsEnriched: number): number {
  return unitsEnriched * APOLLO_ENRICHMENT_COST_CENTS;
}

export function hunterFinderCostCents(foundEmail: boolean): number {
  return foundEmail ? HUNTER_FINDER_COST_CENTS : 0;
}
