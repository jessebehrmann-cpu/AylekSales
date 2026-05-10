import { Badge } from "@/components/ui/badge";
import type { LeadApprovalStatus, LeadStage, SalesProcessStage } from "@/lib/supabase/types";
import { isHumanStage } from "@/lib/playbook-defaults";

/**
 * Status pill for the leads list.
 *
 * Replaces the raw approval_status badge with a status that reads as a
 * single deal-state. Priority order (first match wins):
 *
 *   1. Lost                    — leadStage in (lost, unsubscribed) OR rejected
 *   2. Won                     — leadStage = won
 *   3. Pending review          — approval_status = pending_approval
 *   4. Awaiting human          — current process stage owner = human
 *   5. Proposal sent           — proposal_review approval is approved
 *   6. Proposal pending review — proposal_review approval is pending
 *   7. Active                  — default fallback
 *
 * Both proposal-related buckets are derived from the leadIdsWithSentProposal
 * + leadIdsWithPendingProposal Sets pre-fetched on the leads list page so
 * we don't N+1 the approvals table per row.
 */

export type ComputedStatus =
  | "lost"
  | "won"
  | "pending_review"
  | "awaiting_human"
  | "proposal_sent"
  | "proposal_pending_review"
  | "active";

export function computeLeadStatus(args: {
  approvalStatus: LeadApprovalStatus;
  leadStage: LeadStage;
  currentStage: SalesProcessStage | null;
  proposalSent: boolean;
  proposalPending: boolean;
}): ComputedStatus {
  const {
    approvalStatus,
    leadStage,
    currentStage,
    proposalSent,
    proposalPending,
  } = args;

  // 1. Lost
  if (
    leadStage === "lost" ||
    leadStage === "unsubscribed" ||
    approvalStatus === "rejected"
  ) {
    return "lost";
  }
  // 2. Won
  if (leadStage === "won") return "won";
  // 3. Pending review (HOS hasn't approved the lead-list batch yet)
  if (approvalStatus === "pending_approval") return "pending_review";
  // 4. Awaiting human — playbook's current-stage owner is `human`
  if (currentStage && isHumanStage(currentStage.agent)) return "awaiting_human";
  // 5. Proposal sent (HOS approved + Resend dispatched)
  if (proposalSent) return "proposal_sent";
  // 6. Proposal pending review (post-meeting draft awaiting HOS)
  if (proposalPending) return "proposal_pending_review";
  // 7. Default
  return "active";
}

const META: Record<ComputedStatus, { label: string; klass: string }> = {
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

export function LeadStatusPill({ status }: { status: ComputedStatus }) {
  const meta = META[status];
  return <Badge className={meta.klass}>{meta.label}</Badge>;
}
