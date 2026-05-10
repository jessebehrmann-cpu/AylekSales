import { Badge } from "@/components/ui/badge";
import type { LeadApprovalStatus, LeadStage, SalesProcessStage } from "@/lib/supabase/types";
import { isHumanStage } from "@/lib/playbook-defaults";

/**
 * Status pill for the leads list.
 *
 * Replaces the raw approval_status badge with a status that reads as a
 * single deal-state. Priority order (first match wins):
 *   1. Lost           — lead.stage in (lost, unsubscribed) OR approval_status = rejected
 *   2. Won            — lead.stage = won
 *   3. Pending review — approval_status = pending_approval
 *   4. Proposal sent  — a proposal_review approval for this lead has status='approved'
 *   5. Awaiting human — current process stage agent === 'human'
 *   6. Active         — default (approved + agent-owned stage)
 */

export type ComputedStatus =
  | "lost"
  | "won"
  | "pending_review"
  | "proposal_sent"
  | "awaiting_human"
  | "active";

export function computeLeadStatus(args: {
  approvalStatus: LeadApprovalStatus;
  leadStage: LeadStage;
  currentStage: SalesProcessStage | null;
  proposalSent: boolean;
}): ComputedStatus {
  const { approvalStatus, leadStage, currentStage, proposalSent } = args;
  if (leadStage === "lost" || leadStage === "unsubscribed" || approvalStatus === "rejected") {
    return "lost";
  }
  if (leadStage === "won") return "won";
  if (approvalStatus === "pending_approval") return "pending_review";
  if (proposalSent) return "proposal_sent";
  if (currentStage && isHumanStage(currentStage.agent)) return "awaiting_human";
  return "active";
}

const META: Record<
  ComputedStatus,
  { label: string; variant: "warning" | "success" | "destructive" | "default" | "muted"; klass?: string }
> = {
  lost: { label: "Lost", variant: "destructive" },
  won: { label: "Won", variant: "success" },
  pending_review: { label: "Pending review", variant: "warning" },
  proposal_sent: {
    label: "Proposal sent",
    variant: "default",
    klass: "border-transparent bg-blue-100 text-blue-800",
  },
  awaiting_human: { label: "Awaiting human", variant: "warning" },
  active: { label: "Active", variant: "success" },
};

export function LeadStatusPill({ status }: { status: ComputedStatus }) {
  const meta = META[status];
  if (meta.klass) {
    return <Badge className={meta.klass}>{meta.label}</Badge>;
  }
  return <Badge variant={meta.variant}>{meta.label}</Badge>;
}
