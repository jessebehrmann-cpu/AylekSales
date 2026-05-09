"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { ChevronDown } from "lucide-react";
import { moveLeadToProcessStage } from "./actions";
import type { SalesProcessStage, LeadStage } from "@/lib/supabase/types";
import { colorStage, isHumanStage, type StageColor } from "@/lib/playbook-defaults";

/**
 * Inline coloured pill showing the lead's current sales-process stage.
 * Clicking opens a popover with the full ordered list of stages — pick one
 * to move the lead inline without leaving the leads list.
 */
export function ProcessStageCell({
  leadId,
  leadStage,
  currentStageId,
  stages,
  inferredFromLeadStage,
}: {
  leadId: string;
  leadStage: LeadStage;
  currentStageId: string | null;
  stages: SalesProcessStage[];
  inferredFromLeadStage: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, start] = useTransition();

  if (stages.length === 0) {
    return <span className="text-xs text-muted-foreground">—</span>;
  }

  const stage = stages.find((s) => s.id === currentStageId) ?? null;
  const colour: StageColor = stage
    ? colorStage({
        stages,
        stageId: stage.id,
        currentStageId,
        leadStage,
      })
    : "future";

  function pick(stageId: string) {
    setOpen(false);
    start(async () => {
      const r = await moveLeadToProcessStage(leadId, stageId);
      if (!r.ok) {
        alert(r.error);
        return;
      }
      router.refresh();
    });
  }

  return (
    <div className="relative inline-block">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        disabled={pending}
        className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium transition-colors ${pillColour(colour)} ${inferredFromLeadStage ? "border-dashed" : ""}`}
        title={inferredFromLeadStage ? "Inferred — click to set explicitly" : "Click to move to a different stage"}
      >
        {stage?.name ?? "(unset)"}
        <ChevronDown className="h-3 w-3 opacity-70" />
      </button>
      {open && (
        <>
          {/* click-outside catcher */}
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute left-0 top-full z-50 mt-1 w-56 overflow-hidden rounded-md border bg-popover text-popover-foreground shadow-md">
            <ul className="max-h-72 overflow-y-auto py-1 text-xs">
              {stages.map((s, i) => {
                const c = colorStage({
                  stages,
                  stageId: s.id,
                  currentStageId,
                  leadStage,
                });
                const active = s.id === currentStageId;
                return (
                  <li key={s.id}>
                    <button
                      type="button"
                      onClick={() => pick(s.id)}
                      disabled={pending || active}
                      className={`flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left hover:bg-muted disabled:opacity-60 ${
                        active ? "bg-muted/50 font-semibold" : ""
                      }`}
                    >
                      <span className="flex items-center gap-2">
                        <span className={`inline-block h-2 w-2 rounded-full ${dotColour(c)}`} />
                        {i + 1}. {s.name}
                      </span>
                      {isHumanStage(s.agent) && (
                        <span className="text-[10px] uppercase tracking-wider text-amber-600">
                          human
                        </span>
                      )}
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
        </>
      )}
    </div>
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

function dotColour(c: StageColor): string {
  switch (c) {
    case "completed":
      return "bg-emerald-500";
    case "current":
      return "bg-amber-500";
    case "lost":
      return "bg-rose-500";
    default:
      return "bg-muted-foreground/40";
  }
}
