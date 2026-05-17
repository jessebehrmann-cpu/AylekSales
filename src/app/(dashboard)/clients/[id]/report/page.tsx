import { notFound } from "next/navigation";
import { createClient, createServiceClient } from "@/lib/supabase/server";
import { requireUser } from "@/lib/auth";
import { PageHeader } from "@/components/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatCurrency } from "@/lib/utils";
import type { Client, Lead, Playbook, SalesProcessStage } from "@/lib/supabase/types";
import { inferProcessStageFromLeadStage } from "@/lib/playbook-defaults";

export const dynamic = "force-dynamic";

/**
 * Per-client funnel + month-over-month report. Read-only.
 *
 * Metrics: leads-per-stage, conversion rates between adjacent stages,
 * time-in-stage histogram (best-effort using leads.updated_at), team-
 * member attribution (currently a placeholder — once we track assigned
 * team member per lead we can populate this).
 */
export default async function ClientReportPage({ params }: { params: { id: string } }) {
  const user = await requireUser();
  const isAdmin = user.profile?.role === "admin";
  const supabase = isAdmin ? createServiceClient() : createClient();
  const { data: clientRow } = await supabase
    .from("clients")
    .select("*")
    .eq("id", params.id)
    .maybeSingle();
  const client = (clientRow as Client | null) ?? null;
  if (!client) notFound();

  const [{ data: leadRows }, { data: pbRow }] = await Promise.all([
    supabase
      .from("leads")
      .select("id, stage, process_stage_id, contract_value, created_at, updated_at")
      .eq("client_id", params.id),
    supabase
      .from("playbooks")
      .select("sales_process")
      .eq("client_id", params.id)
      .eq("status", "approved")
      .maybeSingle(),
  ]);

  const leads = (leadRows ?? []) as Array<
    Pick<Lead, "id" | "stage" | "process_stage_id" | "contract_value" | "created_at" | "updated_at">
  >;
  const stages =
    ((pbRow as { sales_process?: SalesProcessStage[] } | null)?.sales_process ?? []) as SalesProcessStage[];

  // Funnel: count leads currently parked at each stage.
  const stageCounts = new Map<string, number>();
  for (const l of leads) {
    const sid = l.process_stage_id ?? inferProcessStageFromLeadStage(l.stage, stages);
    if (!sid) continue;
    stageCounts.set(sid, (stageCounts.get(sid) ?? 0) + 1);
  }

  // Conversion at each step: count(stage i+1) / count(stage i) cumulative.
  const cumulativeByStageIdx = stages.map((_, i) => {
    let total = 0;
    for (let j = i; j < stages.length; j++) {
      total += stageCounts.get(stages[j].id) ?? 0;
    }
    return total;
  });

  // Won / lost / unsubscribed totals (terminal states from lead.stage).
  const won = leads.filter((l) => l.stage === "won").length;
  const lost = leads.filter((l) => l.stage === "lost" || l.stage === "unsubscribed").length;
  const wonRevenue = leads
    .filter((l) => l.stage === "won")
    .reduce((sum, l) => sum + (l.contract_value ?? 0), 0);
  const pipelineRevenue = leads
    .filter((l) => l.stage !== "lost" && l.stage !== "unsubscribed" && l.stage !== "won")
    .reduce((sum, l) => sum + (l.contract_value ?? 0), 0);

  // Time-in-stage: median days since updated_at per stage (rough proxy).
  const now = Date.now();
  const ageDaysByStage = new Map<string, number[]>();
  for (const l of leads) {
    const sid = l.process_stage_id ?? inferProcessStageFromLeadStage(l.stage, stages);
    if (!sid) continue;
    const days = (now - new Date(l.updated_at ?? l.created_at).getTime()) / (24 * 60 * 60 * 1000);
    const arr = ageDaysByStage.get(sid) ?? [];
    arr.push(days);
    ageDaysByStage.set(sid, arr);
  }
  function medianDays(arr: number[]): number {
    if (!arr.length) return 0;
    const sorted = [...arr].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)];
  }

  return (
    <>
      <PageHeader
        title={`${client.name} — report`}
        description="Funnel snapshot, conversion at each stage, and time-in-stage. Read-only."
      />

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Metric label="Total leads" value={leads.length} />
        <Metric label="Won" value={won} />
        <Metric label="Won revenue" value={formatCurrency(wonRevenue)} />
        <Metric label="Open pipeline value" value={formatCurrency(pipelineRevenue)} />
      </div>

      <Card className="mt-6">
        <CardHeader>
          <CardTitle className="text-base">Funnel + conversion</CardTitle>
        </CardHeader>
        <CardContent>
          {stages.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No approved playbook yet — submit one before this report has stages to chart.
            </p>
          ) : (
            <table className="w-full text-sm">
              <thead className="text-left text-xs uppercase tracking-wider text-muted-foreground">
                <tr>
                  <th className="pb-2">Stage</th>
                  <th className="pb-2 text-right">At stage</th>
                  <th className="pb-2 text-right">Cumulative</th>
                  <th className="pb-2 text-right">Pass-through</th>
                  <th className="pb-2 text-right">Median age (days)</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {stages.map((s, i) => {
                  const at = stageCounts.get(s.id) ?? 0;
                  const cumulative = cumulativeByStageIdx[i];
                  const prev = i > 0 ? cumulativeByStageIdx[i - 1] : null;
                  const passThrough = prev && prev > 0 ? Math.round((cumulative / prev) * 100) : null;
                  const age = medianDays(ageDaysByStage.get(s.id) ?? []);
                  return (
                    <tr key={s.id}>
                      <td className="py-2 font-medium">
                        {i + 1}. {s.name}
                      </td>
                      <td className="py-2 text-right tabular-nums">{at}</td>
                      <td className="py-2 text-right tabular-nums text-muted-foreground">{cumulative}</td>
                      <td className="py-2 text-right tabular-nums">
                        {passThrough != null ? `${passThrough}%` : "—"}
                      </td>
                      <td className="py-2 text-right tabular-nums">{age.toFixed(1)}</td>
                    </tr>
                  );
                })}
                <tr className="border-t">
                  <td className="py-2 font-medium">Won (terminal)</td>
                  <td className="py-2 text-right tabular-nums">{won}</td>
                  <td colSpan={3} />
                </tr>
                <tr>
                  <td className="py-2 font-medium text-muted-foreground">Lost / unsubscribed</td>
                  <td className="py-2 text-right tabular-nums">{lost}</td>
                  <td colSpan={3} />
                </tr>
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>
    </>
  );
}

function Metric({ label, value }: { label: string; value: string | number }) {
  return (
    <Card>
      <CardContent className="pt-6">
        <p className="text-[10px] font-medium uppercase tracking-[0.15em] text-muted-foreground">{label}</p>
        <p className="mt-1 text-2xl font-semibold tabular-nums">{value}</p>
      </CardContent>
    </Card>
  );
}
