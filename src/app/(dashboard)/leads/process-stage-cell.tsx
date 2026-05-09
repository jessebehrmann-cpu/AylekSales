import type { SalesProcessStage, LeadStage } from "@/lib/supabase/types";
import { colorStage, type StageColor } from "@/lib/playbook-defaults";

/**
 * Read-only coloured pill showing the lead's current sales-process stage,
 * matching the timeline colour scheme. Stage advancement is fully automatic
 * (agents complete their tasks, or HOS marks human stages complete from the
 * lead detail page) — the leads list never lets you move a lead by hand.
 */
export function ProcessStageCell({
  leadStage,
  currentStageId,
  stages,
  inferredFromLeadStage,
}: {
  leadStage: LeadStage;
  currentStageId: string | null;
  stages: SalesProcessStage[];
  inferredFromLeadStage: boolean;
}) {
  if (stages.length === 0) {
    return <span className="text-xs text-muted-foreground">—</span>;
  }
  const stage = stages.find((s) => s.id === currentStageId) ?? null;
  const colour: StageColor = stage
    ? colorStage({ stages, stageId: stage.id, currentStageId, leadStage })
    : "future";

  return (
    <span
      className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${pillColour(colour)} ${inferredFromLeadStage ? "border-dashed" : ""}`}
      title={inferredFromLeadStage ? "Inferred from lead stage" : stage?.description ?? stage?.name ?? ""}
    >
      {stage?.name ?? "(unset)"}
    </span>
  );
}

function pillColour(c: StageColor): string {
  switch (c) {
    case "completed":
      return "border-emerald-300 bg-emerald-50 text-emerald-800";
    case "current":
      return "border-amber-300 bg-amber-50 text-amber-900";
    case "lost":
      return "border-rose-300 bg-rose-50 text-rose-800";
    default:
      return "border-border bg-muted text-muted-foreground";
  }
}
