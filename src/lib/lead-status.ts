/**
 * Single source of truth for the computed status of a lead.
 *
 * Every place that displays a lead's "current state" — the leads list pill,
 * the lead detail page, the dashboard activity feed — derives that label
 * from `computeLeadStatus()` here. There is no other place a status is
 * inferred.
 *
 * Inputs the function needs:
 *   • approval_status (lead row column) — has the HOS-level lead_list batch
 *     been approved?
 *   • leadStage (lead row column) — coarse-grained funnel stage
 *   • currentStage (resolved SalesProcessStage) — the playbook stage the
 *     lead is parked at, or null if no playbook / no stage
 *   • proposalSent / proposalPending — pre-fetched per-lead booleans driven
 *     by `fetchProposalApprovalSets()`. Stop the leads page from N+1ing the
 *     approvals table.
 *
 * Priority order (first match wins):
 *   1. Lost                    — leadStage in (lost, unsubscribed) OR rejected
 *   2. Won                     — leadStage = won
 *   3. Pending review          — approval_status = pending_approval
 *   4. Awaiting human          — current process stage owner = human
 *   5. Proposal sent           — a proposal_review approval is approved
 *   6. Proposal pending review — a proposal_review approval is pending
 *   7. Active                  — default fallback
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  Database,
  LeadApprovalStatus,
  LeadStage,
  ProposalReviewPayload,
  SalesProcessStage,
} from "@/lib/supabase/types";
import { isHumanStage } from "@/lib/playbook-defaults";

export type ComputedStatus =
  | "lost"
  | "won"
  | "pending_review"
  | "awaiting_human"
  | "proposal_sent"
  | "proposal_pending_review"
  | "active";

export type StatusInputs = {
  approvalStatus: LeadApprovalStatus;
  leadStage: LeadStage;
  currentStage: SalesProcessStage | null;
  proposalSent: boolean;
  proposalPending: boolean;
};

export function computeLeadStatus(args: StatusInputs): ComputedStatus {
  const {
    approvalStatus,
    leadStage,
    currentStage,
    proposalSent,
    proposalPending,
  } = args;

  if (
    leadStage === "lost" ||
    leadStage === "unsubscribed" ||
    approvalStatus === "rejected"
  ) {
    return "lost";
  }
  if (leadStage === "won") return "won";
  if (approvalStatus === "pending_approval") return "pending_review";
  if (currentStage && isHumanStage(currentStage.agent)) return "awaiting_human";
  if (proposalSent) return "proposal_sent";
  if (proposalPending) return "proposal_pending_review";
  return "active";
}

export const STATUS_META: Record<ComputedStatus, { label: string; klass: string }> = {
  lost: {
    label: "Lost",
    klass: "border-transparent bg-rose-100 text-rose-800",
  },
  won: {
    label: "Won",
    klass: "border-transparent bg-emerald-100 text-emerald-800",
  },
  pending_review: {
    label: "Pending review",
    klass: "border-transparent bg-amber-100 text-amber-900",
  },
  awaiting_human: {
    label: "Awaiting human",
    klass: "border-transparent bg-amber-100 text-amber-900",
  },
  proposal_sent: {
    label: "Proposal sent",
    klass: "border-transparent bg-blue-100 text-blue-800",
  },
  proposal_pending_review: {
    label: "Proposal pending review",
    klass: "border-transparent bg-amber-100 text-amber-900",
  },
  active: {
    label: "Active",
    klass: "border-transparent bg-emerald-100 text-emerald-800",
  },
};

// ──────────────────────────────────────────────────────────────────────────
// Server-side helpers (used by leads list page)
// ──────────────────────────────────────────────────────────────────────────

/**
 * Look up which leads currently have a `proposal_review` approval that's
 * approved (proposal_sent) vs pending (proposal_pending_review). Returns
 * two Sets keyed by lead_id.
 *
 * The approval payload always carries `lead_id` (per ProposalReviewPayload),
 * so the lookup is a single round trip.
 *
 * Falls back gracefully — if `payload.lead_id` is missing on legacy rows
 * (pre-stage-engine refactor), the row is ignored. The backfill script
 * patches those.
 */
export async function fetchProposalApprovalSets(
  supabase: SupabaseClient<Database>,
  leadIds: string[],
): Promise<{ sent: Set<string>; pending: Set<string> }> {
  const sent = new Set<string>();
  const pending = new Set<string>();
  if (leadIds.length === 0) return { sent, pending };

  const { data } = await supabase
    .from("approvals")
    .select("status, payload")
    .eq("type", "proposal_review");

  for (const row of (data ?? []) as Array<{
    status: string;
    payload: ProposalReviewPayload | null;
  }>) {
    const leadId = row.payload?.lead_id;
    if (!leadId || !leadIds.includes(leadId)) continue;
    if (row.status === "approved") sent.add(leadId);
    else if (row.status === "pending") pending.add(leadId);
  }

  return { sent, pending };
}
