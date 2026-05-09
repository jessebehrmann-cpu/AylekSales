"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Check, X } from "lucide-react";
import { approveLeadInBatch, rejectLeadInBatch } from "@/app/(dashboard)/approvals/actions";
import { ApprovalBadge } from "@/components/approval-badge";
import type { LeadApprovalStatus } from "@/lib/supabase/types";

/**
 * Tiny cell shown on the /leads list when filtered by ?approval=<id>.
 * For pending_approval leads renders Approve / Reject buttons that flip a
 * single lead inline. Already-decided leads just show their badge.
 */
export function InlineApprovalCell({
  leadId,
  approvalId,
  status,
}: {
  leadId: string;
  approvalId: string;
  status: LeadApprovalStatus;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [optimistic, setOptimistic] = useState<LeadApprovalStatus>(status);
  const [error, setError] = useState<string | null>(null);

  function decide(decision: "approved" | "rejected") {
    setError(null);
    setOptimistic(decision);
    start(async () => {
      const fn = decision === "approved" ? approveLeadInBatch : rejectLeadInBatch;
      const r = await fn({ approval_id: approvalId, lead_id: leadId });
      if (!r.ok) {
        setOptimistic(status);
        setError(r.error);
        return;
      }
      router.refresh();
    });
  }

  if (optimistic !== "pending_approval") {
    return <ApprovalBadge status={optimistic} />;
  }

  return (
    <div className="flex items-center gap-1.5">
      <button
        type="button"
        onClick={() => decide("approved")}
        disabled={pending}
        title="Approve this lead"
        className="inline-flex h-7 items-center gap-1 rounded-md border border-emerald-300 bg-emerald-50 px-2 text-xs font-medium text-emerald-800 hover:bg-emerald-100 disabled:opacity-50"
      >
        <Check className="h-3 w-3" /> Approve
      </button>
      <button
        type="button"
        onClick={() => decide("rejected")}
        disabled={pending}
        title="Reject this lead"
        className="inline-flex h-7 items-center gap-1 rounded-md border border-rose-300 bg-rose-50 px-2 text-xs font-medium text-rose-800 hover:bg-rose-100 disabled:opacity-50"
      >
        <X className="h-3 w-3" /> Reject
      </button>
      {error && <span className="text-xs text-destructive">{error}</span>}
    </div>
  );
}
