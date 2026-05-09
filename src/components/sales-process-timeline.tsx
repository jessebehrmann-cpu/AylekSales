"use client";

import { cn } from "@/lib/utils";
import { Check, AlertCircle, X } from "lucide-react";
import type { SalesProcessStage } from "@/lib/supabase/types";
import {
  colorStage,
  isHumanStage,
  labelForAgent,
  type StageColor,
} from "@/lib/playbook-defaults";

/**
 * Horizontal timeline of sales-process stages.
 *
 * Three flavours:
 *  - "preview" — no lead context, just shows the stages (for the playbook editor)
 *  - "lead"    — coloured per the supplied lead's progress; clicking a stage
 *                fires onStageClick(stageId)
 *
 * Colour key:
 *  - completed (green) — the lead has passed this stage
 *  - current   (yellow) — the lead is here right now
 *  - lost      (red)    — the lead died at this stage
 *  - future    (grey)   — the lead hasn't reached this yet
 */

export type TimelineLead = {
  stage: string;
  process_stage_id: string | null;
};

export function SalesProcessTimeline({
  stages,
  lead,
  onStageClick,
  compact = false,
}: {
  stages: SalesProcessStage[];
  lead?: TimelineLead;
  onStageClick?: (stageId: string) => void;
  compact?: boolean;
}) {
  if (stages.length === 0) {
    return (
      <p className="rounded-lg border border-dashed border-[#1e1e2e] bg-[#0e0e18] px-4 py-6 text-center text-sm text-[#52526e]">
        No sales process stages yet. Add some on the Sales Process tab.
      </p>
    );
  }

  return (
    <div className="overflow-x-auto py-2">
      <div className={cn("flex items-start gap-0", compact ? "min-w-[640px]" : "min-w-[760px]")}>
        {stages.map((s, i) => {
          const color: StageColor = lead
            ? colorStage({
                stages,
                stageId: s.id,
                currentStageId: lead.process_stage_id,
                leadStage: lead.stage,
              })
            : "future";
          const isLast = i === stages.length - 1;

          return (
            <div key={s.id} className={cn("flex shrink-0", isLast ? "" : "flex-1")}>
              <StageNode
                stage={s}
                color={color}
                index={i}
                compact={compact}
                onClick={onStageClick ? () => onStageClick(s.id) : undefined}
              />
              {!isLast && (
                <div className="mt-4 flex-1">
                  <div
                    className={cn(
                      "h-px transition-colors",
                      color === "completed"
                        ? "bg-emerald-500/60"
                        : color === "current"
                        ? "bg-amber-500/60"
                        : color === "lost"
                        ? "bg-rose-500/60"
                        : "bg-[#1e1e2e]",
                    )}
                  />
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function StageNode({
  stage,
  color,
  index,
  compact,
  onClick,
}: {
  stage: SalesProcessStage;
  color: StageColor;
  index: number;
  compact: boolean;
  onClick?: () => void;
}) {
  const ring = colorRing(color);
  const dot = colorDot(color);
  const Icon =
    color === "completed" ? Check : color === "lost" ? X : color === "current" ? AlertCircle : null;
  const showHuman = isHumanStage(stage.agent);

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={!onClick}
      className={cn(
        "group flex w-32 flex-col items-center gap-1.5 px-1 text-center",
        onClick ? "cursor-pointer" : "cursor-default",
      )}
      title={onClick ? `Move to ${stage.name}` : stage.description || stage.name}
    >
      <div
        className={cn(
          "flex h-9 w-9 items-center justify-center rounded-full border-2 text-xs font-bold transition-transform",
          ring,
          dot,
          onClick && "group-hover:scale-110",
        )}
      >
        {Icon ? <Icon className="h-4 w-4" /> : index + 1}
      </div>
      <p
        className={cn(
          "line-clamp-2 px-1 font-medium leading-tight",
          compact ? "text-[10px]" : "text-xs",
          color === "completed"
            ? "text-emerald-400"
            : color === "current"
            ? "text-amber-300"
            : color === "lost"
            ? "text-rose-400"
            : "text-[#b0b0c8]",
        )}
      >
        {stage.name || `Stage ${index + 1}`}
      </p>
      <p
        className={cn(
          "line-clamp-1 text-[9px] uppercase tracking-wider",
          showHuman ? "text-amber-300" : "text-[#52526e]",
        )}
      >
        {labelForAgent(stage.agent)}
      </p>
    </button>
  );
}

function colorRing(c: StageColor): string {
  switch (c) {
    case "completed":
      return "border-emerald-500/70";
    case "current":
      return "border-amber-500";
    case "lost":
      return "border-rose-500/80";
    default:
      return "border-[#262636]";
  }
}

function colorDot(c: StageColor): string {
  switch (c) {
    case "completed":
      return "bg-emerald-500/20 text-emerald-400";
    case "current":
      return "bg-amber-500/20 text-amber-300";
    case "lost":
      return "bg-rose-500/20 text-rose-400";
    default:
      return "bg-[#0e0e18] text-[#52526e]";
  }
}
