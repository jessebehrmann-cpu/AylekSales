"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { X, ExternalLink } from "lucide-react";
import { formatDateTime } from "@/lib/utils";
import type { SalesProcessStage } from "@/lib/supabase/types";

/**
 * Horizontal sales funnel + slide-out drill-down.
 *
 * Each bar's width is proportional to the count of leads at that stage.
 * Clicking opens a right-side panel listing the leads currently parked there
 * (name, contact, time-at-stage). Click outside or hit X to dismiss.
 */

export type StageCount = { stageId: string; name: string; count: number };
export type FunnelLead = {
  id: string;
  company_name: string;
  contact_name: string | null;
  /** Best-effort proxy for "how long at this stage" — using leads.updated_at
   *  until we add a dedicated stage-entered timestamp. */
  updated_at: string;
};

export function SalesFunnel({
  clientOptions,
  selectedClientId,
  stages,
  counts,
  leadsByStage,
}: {
  clientOptions: Array<{ id: string; name: string }>;
  selectedClientId: string | null;
  stages: SalesProcessStage[];
  counts: StageCount[];
  leadsByStage: Record<string, FunnelLead[]>;
}) {
  const router = useRouter();
  const [openStageId, setOpenStageId] = useState<string | null>(null);
  const max = Math.max(1, ...counts.map((c) => c.count));
  const lastNonEmptyIdx = lastIndexWithLeads(stages, counts);

  // ESC closes the panel
  useEffect(() => {
    if (!openStageId) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpenStageId(null);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [openStageId]);

  const openStage = openStageId ? stages.find((s) => s.id === openStageId) ?? null : null;
  const openLeads = openStageId ? leadsByStage[openStageId] ?? [] : [];

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-3">
        <CardTitle className="text-base">Sales funnel</CardTitle>
        {clientOptions.length > 1 && (
          <Select
            value={selectedClientId ?? ""}
            onValueChange={(v) => router.push(`/dashboard?client=${v}`)}
          >
            <SelectTrigger className="h-8 w-56 text-xs">
              <SelectValue placeholder="Pick a client" />
            </SelectTrigger>
            <SelectContent>
              {clientOptions.map((c) => (
                <SelectItem key={c.id} value={c.id}>
                  {c.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </CardHeader>
      <CardContent>
        {stages.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted-foreground">
            {selectedClientId
              ? "No approved playbook yet for this client — funnel needs sales_process stages."
              : "Pick a client to view the funnel."}
          </p>
        ) : (
          <ul className="space-y-1.5">
            {stages.map((s, i) => {
              const c = counts.find((x) => x.stageId === s.id)?.count ?? 0;
              const widthPct = Math.max(6, (c / max) * 100);
              const colour = c > 0 ? "active" : i < lastNonEmptyIdx ? "completed" : "future";
              return (
                <li key={s.id}>
                  <button
                    type="button"
                    onClick={() => setOpenStageId(s.id)}
                    className="group flex w-full items-center gap-3 rounded-md px-2 py-1 text-left transition-colors hover:bg-muted/60"
                  >
                    <div className="w-32 shrink-0 text-xs font-medium text-foreground/90">
                      {i + 1}. {s.name}
                    </div>
                    <div className="flex-1 overflow-hidden rounded-full bg-muted/50">
                      <div
                        className={`h-6 rounded-full ${barColour(colour)} transition-all`}
                        style={{ width: `${widthPct}%` }}
                      />
                    </div>
                    <div className="w-10 shrink-0 text-right text-xs font-semibold tabular-nums">
                      {c}
                    </div>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>

      {openStage && (
        <StageDrillDown
          stage={openStage}
          leads={openLeads}
          onClose={() => setOpenStageId(null)}
        />
      )}
    </Card>
  );
}

function StageDrillDown({
  stage,
  leads,
  onClose,
}: {
  stage: SalesProcessStage;
  leads: FunnelLead[];
  onClose: () => void;
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex justify-end bg-black/30"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <aside className="flex h-full w-full max-w-md flex-col bg-card text-card-foreground shadow-xl">
        <div className="flex items-start justify-between border-b px-5 py-4">
          <div className="min-w-0">
            <p className="text-[10px] font-semibold uppercase tracking-[0.15em] text-muted-foreground">
              Stage
            </p>
            <h2 className="mt-1 truncate text-lg font-semibold">{stage.name}</h2>
            <p className="mt-1 text-xs text-muted-foreground">
              {leads.length} lead{leads.length === 1 ? "" : "s"} currently here
              {stage.agent ? ` · owned by ${stage.agent}` : ""}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md p-1 text-muted-foreground hover:bg-muted"
            title="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto px-5 py-4">
          {leads.length === 0 ? (
            <p className="text-sm text-muted-foreground">No leads at this stage.</p>
          ) : (
            <ul className="space-y-2">
              {leads.map((l) => (
                <li key={l.id}>
                  <Link
                    href={`/leads/${l.id}`}
                    onClick={onClose}
                    className="flex items-start justify-between gap-3 rounded-lg border bg-background p-3 transition-colors hover:bg-muted/50"
                  >
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium text-foreground">
                        {l.company_name}
                      </p>
                      {l.contact_name && (
                        <p className="mt-0.5 truncate text-xs text-muted-foreground">
                          {l.contact_name}
                        </p>
                      )}
                      <p className="mt-1 text-[11px] text-muted-foreground">
                        At this stage for {timeAgo(l.updated_at)} · since {formatDateTime(l.updated_at)}
                      </p>
                    </div>
                    <ExternalLink className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>
      </aside>
    </div>
  );
}

function lastIndexWithLeads(stages: SalesProcessStage[], counts: StageCount[]): number {
  let last = -1;
  for (let i = 0; i < stages.length; i++) {
    const c = counts.find((x) => x.stageId === stages[i].id)?.count ?? 0;
    if (c > 0) last = i;
  }
  return last;
}

function barColour(c: "active" | "completed" | "future"): string {
  switch (c) {
    case "active":
      return "bg-amber-400/80";
    case "completed":
      return "bg-emerald-500/70";
    default:
      return "bg-muted";
  }
}

function timeAgo(isoTs: string): string {
  const then = new Date(isoTs).getTime();
  const now = Date.now();
  if (!Number.isFinite(then)) return "—";
  const sec = Math.max(0, Math.round((now - then) / 1000));
  if (sec < 60) return `${sec}s`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m`;
  const hr = Math.round(min / 60);
  if (hr < 48) return `${hr}h`;
  const d = Math.round(hr / 24);
  if (d < 31) return `${d}d`;
  const mo = Math.round(d / 30);
  return `${mo}mo`;
}
