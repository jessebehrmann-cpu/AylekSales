"use client";

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
import type { SalesProcessStage } from "@/lib/supabase/types";

/**
 * Horizontal sales funnel for the dashboard.
 *
 * Each stage's bar width is proportional to the count of leads currently at
 * that stage (process_stage_id). Colour rules echo the per-lead timeline:
 *   - yellow → has leads currently here ("active")
 *   - green  → empty here, but later stages have leads ("completed")
 *   - grey   → empty here AND no later stages have leads ("not started")
 *
 * Clicking a stage deep-links to /leads filtered to that client + stage.
 */

export type StageCount = { stageId: string; name: string; count: number };

export function SalesFunnel({
  clientOptions,
  selectedClientId,
  stages,
  counts,
}: {
  clientOptions: Array<{ id: string; name: string }>;
  selectedClientId: string | null;
  stages: SalesProcessStage[];
  counts: StageCount[];
}) {
  const router = useRouter();
  const max = Math.max(1, ...counts.map((c) => c.count));
  const lastNonEmptyIdx = lastIndexWithLeads(stages, counts);

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
              const widthPct = Math.max(6, (c / max) * 100); // floor so empty stages still register
              const colour = c > 0 ? "active" : i < lastNonEmptyIdx ? "completed" : "future";
              const href = selectedClientId
                ? `/leads?client=${selectedClientId}&stage=${stageToLeadStage(s.id)}`
                : "/leads";
              return (
                <li key={s.id}>
                  <Link
                    href={href}
                    className="group flex items-center gap-3 rounded-md px-2 py-1 hover:bg-muted/60"
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
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>
    </Card>
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

/** Best-effort map from sales_process stage id → leads.stage filter value
 *  for the deep link. Defaults to "new" if no obvious mapping. */
function stageToLeadStage(stageId: string): string {
  const map: Record<string, string> = {
    prospect: "new",
    outreach: "contacted",
    book_meeting: "replied",
    have_meeting: "meeting_booked",
    send_proposal: "quoted",
    execute_contract: "quoted",
    payment: "won",
    onboard: "won",
    handover: "won",
  };
  return map[stageId] ?? "new";
}
