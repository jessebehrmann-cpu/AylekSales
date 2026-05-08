import { Badge } from "@/components/ui/badge";
import type { LeadApprovalStatus } from "@/lib/supabase/types";

const VARIANT: Record<LeadApprovalStatus, "warning" | "success" | "destructive"> = {
  pending_approval: "warning",
  approved: "success",
  rejected: "destructive",
};

const LABEL: Record<LeadApprovalStatus, string> = {
  pending_approval: "Pending approval",
  approved: "Approved",
  rejected: "Rejected",
};

export function ApprovalBadge({ status }: { status: LeadApprovalStatus }) {
  return <Badge variant={VARIANT[status] ?? "muted"}>{LABEL[status] ?? status}</Badge>;
}
