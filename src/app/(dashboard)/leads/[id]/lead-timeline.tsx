"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Card, CardContent } from "@/components/ui/card";
import { Alert } from "@/components/ui/alert";
import { SalesProcessTimeline } from "@/components/sales-process-timeline";
import { moveLeadToProcessStage } from "../actions";
import type { SalesProcessStage } from "@/lib/supabase/types";

/**
 * Sales-process timeline shown at the top of each lead's detail page.
 * Clicking a node moves the lead to that stage. If the destination stage is
 * owned by a "Human in the loop" agent, the action also records a
 * human_handoff_required event for HOS visibility.
 */
export function LeadTimelineCard({
  leadId,
  stages,
  currentStageId,
  leadStage,
  isExplicit,
}: {
  leadId: string;
  stages: SalesProcessStage[];
  currentStageId: string | null;
  leadStage: string;
  isExplicit: boolean;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function onClickStage(stageId: string) {
    setError(null);
    if (stageId === currentStageId) return;
    start(async () => {
      const r = await moveLeadToProcessStage(leadId, stageId);
      if (!r.ok) {
        setError(r.error);
        return;
      }
      router.refresh();
    });
  }

  return (
    <Card className="mb-6 border-[#1e1e2e] bg-[#080810] text-[#eeeef5]">
      <CardContent className="pt-6">
        <div className="mb-3 flex items-baseline justify-between">
          <p className="text-[10px] font-semibold uppercase tracking-[0.15em] text-[#52526e]">
            Sales process
          </p>
          {!isExplicit && (
            <p className="text-[10px] uppercase tracking-wider text-amber-400">
              Inferred from lead stage — click a node to set explicitly.
            </p>
          )}
        </div>
        <SalesProcessTimeline
          stages={stages}
          lead={{ stage: leadStage, process_stage_id: currentStageId }}
          onStageClick={pending ? undefined : onClickStage}
        />
        {pending && (
          <p className="mt-2 text-xs text-amber-300/80 animate-pulse-soft">Moving…</p>
        )}
        {error && <Alert variant="destructive" className="mt-3">{error}</Alert>}
      </CardContent>
    </Card>
  );
}
