"use client";

import { useState } from "react";
import { ApprovalBadge } from "@/components/approval-badge";
import {
  DeleteLeadButton,
  MarkStageCompleteButton,
  UnsubscribeLeadButton,
} from "./lead-actions";
import { PostMeetingModal } from "./post-meeting-modal";
import type { LeadApprovalStatus, SalesProcessStage } from "@/lib/supabase/types";
import { isHumanStage } from "@/lib/playbook-defaults";

/**
 * Header actions row + the post-meeting modal trigger. Lives in a single
 * client component so the Mark Complete button can hand off to the modal
 * without a full page round-trip on the Have-Meeting stage.
 */
export function LeadDetailHeaderActions({
  leadId,
  approvalStatus,
  leadStage,
  currentStage,
  onHumanStage,
}: {
  leadId: string;
  approvalStatus: LeadApprovalStatus;
  leadStage: string;
  currentStage: SalesProcessStage | null;
  onHumanStage: boolean;
}) {
  const [meetingModalOpen, setMeetingModalOpen] = useState(false);
  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        <ApprovalBadge status={approvalStatus} />
        <StageStatusPill currentStage={currentStage} />
        {onHumanStage && currentStage && (
          <MarkStageCompleteButton
            leadId={leadId}
            stageId={currentStage.id}
            stageName={currentStage.name}
            onOpenMeetingModal={
              currentStage.id === "have_meeting"
                ? () => setMeetingModalOpen(true)
                : undefined
            }
          />
        )}
        <UnsubscribeLeadButton
          leadId={leadId}
          alreadyUnsubscribed={leadStage === "unsubscribed"}
        />
        <DeleteLeadButton leadId={leadId} />
      </div>

      <PostMeetingModal
        leadId={leadId}
        open={meetingModalOpen}
        onOpenChange={setMeetingModalOpen}
      />
    </>
  );
}

/**
 * Header pill summarising the current process-stage status:
 *   • Pending human action  (amber) — at a human-owned stage
 *   • In progress           (yellow) — agent is working this stage
 *   • Completed             (green) — past the stage / end of pipeline
 */
function StageStatusPill({ currentStage }: { currentStage: SalesProcessStage | null }) {
  if (!currentStage) return null;
  const human = isHumanStage(currentStage.agent);
  const klass = human
    ? "border-amber-300 bg-amber-100 text-amber-900"
    : "border-yellow-300 bg-yellow-50 text-yellow-900";
  const label = human ? "Pending human action" : "In progress";
  return (
    <span
      className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium ${klass}`}
      title={`${currentStage.name} — owned by ${human ? "human" : currentStage.agent}`}
    >
      {label} · {currentStage.name}
    </span>
  );
}
