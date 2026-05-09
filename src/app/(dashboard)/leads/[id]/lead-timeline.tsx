import { Card, CardContent } from "@/components/ui/card";
import { SalesProcessTimeline } from "@/components/sales-process-timeline";
import type { SalesProcessStage } from "@/lib/supabase/types";

/**
 * View-only sales-process timeline at the top of each lead's detail page.
 *
 * Stages advance automatically when the responsible agent completes its
 * task, or when the HOS marks a human-owned stage complete from the lead
 * detail page. Hand-clicking a node to override is intentionally NOT
 * available — the timeline is the single source of truth, the operator
 * either runs an agent or marks a stage complete.
 */
export function LeadTimelineCard({
  stages,
  currentStageId,
  leadStage,
  isExplicit,
}: {
  stages: SalesProcessStage[];
  currentStageId: string | null;
  leadStage: string;
  isExplicit: boolean;
}) {
  return (
    <Card className="mb-6 border-[#1e1e2e] bg-[#080810] text-[#eeeef5]">
      <CardContent className="pt-6">
        <div className="mb-3 flex items-baseline justify-between">
          <p className="text-[10px] font-semibold uppercase tracking-[0.15em] text-[#52526e]">
            Sales process
          </p>
          {!isExplicit && (
            <p className="text-[10px] uppercase tracking-wider text-amber-400">
              Inferred from lead history — will be set explicitly once an agent acts.
            </p>
          )}
        </div>
        <SalesProcessTimeline
          stages={stages}
          lead={{ stage: leadStage, process_stage_id: currentStageId }}
        />
      </CardContent>
    </Card>
  );
}
