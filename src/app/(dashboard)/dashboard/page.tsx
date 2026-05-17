import { createClient } from "@/lib/supabase/server";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { PageHeader } from "@/components/page-header";
import { formatDateTime, formatCurrency } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import Link from "next/link";
import { Plus, Upload, Send, Hand } from "lucide-react";
import { SalesFunnel, type FunnelLead, type StageCount } from "./sales-funnel";
import type { AppEvent, SalesProcessStage } from "@/lib/supabase/types";
import { inferProcessStageFromLeadStage } from "@/lib/playbook-defaults";
import { describeEvent } from "@/lib/event-format";

export const dynamic = "force-dynamic";

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: { client?: string };
}) {
  const supabase = createClient();

  const since7d = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const sinceMonth = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);

  const [
    { count: activeClients },
    { count: totalLeads },
    { data: pipelineRows },
    { count: emailsToday },
    { count: emailsSent7d },
    { count: repliesIn7d },
    { count: meetingsThisMonth },
    { data: wonRows },
    { data: recentEvents },
    { count: pendingApprovals },
  ] = await Promise.all([
    supabase.from("clients").select("id", { count: "exact", head: true }).eq("status", "active"),
    supabase.from("leads").select("id", { count: "exact", head: true }),
    supabase.from("leads").select("contract_value").not("contract_value", "is", null),
    supabase
      .from("emails")
      .select("id", { count: "exact", head: true })
      .gte("sent_at", startOfDay.toISOString()),
    supabase.from("emails").select("id", { count: "exact", head: true }).gte("sent_at", since7d),
    supabase
      .from("emails")
      .select("id", { count: "exact", head: true })
      .gte("replied_at", since7d)
      .not("replied_at", "is", null),
    supabase
      .from("meetings")
      .select("id", { count: "exact", head: true })
      .gte("created_at", sinceMonth),
    supabase
      .from("quotes")
      .select("amount")
      .eq("status", "accepted")
      .gte("responded_at", sinceMonth),
    supabase.from("events").select("*").order("created_at", { ascending: false }).limit(50),
    supabase
      .from("approvals")
      .select("id", { count: "exact", head: true })
      .eq("status", "pending"),
  ]);

  const pipelineValue = (pipelineRows ?? []).reduce(
    (sum, row) => sum + (row.contract_value ?? 0),
    0,
  );
  const wonValue = (wonRows ?? []).reduce((sum, row) => sum + (row.amount ?? 0), 0);
  const replyRate =
    emailsSent7d && emailsSent7d > 0 ? ((repliesIn7d ?? 0) / emailsSent7d) * 100 : null;

  const stats = [
    { label: "Active clients", value: activeClients ?? 0 },
    { label: "Total leads", value: totalLeads ?? 0 },
    { label: "Pipeline value", value: formatCurrency(pipelineValue) },
    { label: "Emails sent today", value: emailsToday ?? 0 },
    { label: "Reply rate (7d)", value: replyRate == null ? "—" : `${replyRate.toFixed(1)}%` },
    { label: "Meetings this month", value: meetingsThisMonth ?? 0 },
    { label: "Revenue won (30d)", value: formatCurrency(wonValue) },
  ];

  // ── Funnel data ────────────────────────────────────────────────────────
  // Pull active clients with approved playbooks (so the funnel has stages).
  // If a client param is supplied, use it; otherwise default to the first.
  const { data: activeClientRows } = await supabase
    .from("clients")
    .select("id, name")
    .eq("status", "active")
    .order("name");
  const clientOptions = (activeClientRows ?? []) as Array<{ id: string; name: string }>;
  const selectedClientId = searchParams.client ?? clientOptions[0]?.id ?? null;

  let funnelStages: SalesProcessStage[] = [];
  let funnelCounts: StageCount[] = [];
  let funnelLeadsByStage: Record<string, FunnelLead[]> = {};
  if (selectedClientId) {
    const { data: pbRow } = await supabase
      .from("playbooks")
      .select("sales_process")
      .eq("client_id", selectedClientId)
      .eq("status", "approved")
      .maybeSingle();
    funnelStages = ((pbRow as { sales_process?: SalesProcessStage[] } | null)?.sales_process ?? []) as SalesProcessStage[];

    if (funnelStages.length > 0) {
      const { data: clientLeads } = await supabase
        .from("leads")
        .select("id, company_name, contact_name, stage, process_stage_id, updated_at")
        .eq("client_id", selectedClientId);

      const byStage = new Map<string, FunnelLead[]>();
      for (const l of (clientLeads ?? []) as Array<{
        id: string;
        company_name: string;
        contact_name: string | null;
        stage: string;
        process_stage_id: string | null;
        updated_at: string;
      }>) {
        const stageId = l.process_stage_id ?? inferProcessStageFromLeadStage(l.stage, funnelStages);
        if (!stageId) continue;
        const arr = byStage.get(stageId) ?? [];
        arr.push({
          id: l.id,
          company_name: l.company_name,
          contact_name: l.contact_name,
          updated_at: l.updated_at,
        });
        byStage.set(stageId, arr);
      }
      funnelCounts = funnelStages.map((s) => ({
        stageId: s.id,
        name: s.name,
        count: (byStage.get(s.id) ?? []).length,
      }));
      funnelLeadsByStage = Object.fromEntries(byStage);
    }
  }

  return (
    <>
      {(pendingApprovals ?? 0) > 0 && (
        <Link
          href="/approvals"
          className="mb-4 flex items-center gap-3 rounded-lg border border-amber-300/50 bg-amber-50 px-4 py-3 transition-colors hover:bg-amber-100/70"
        >
          <Hand className="h-5 w-5 text-amber-600" />
          <p className="flex-1 text-sm text-amber-900">
            <strong>{pendingApprovals} item{pendingApprovals === 1 ? "" : "s"} need your approval</strong> —
            lead lists or strategy changes are blocked until you review.
          </p>
          <span className="rounded-md border border-amber-400/60 bg-amber-100 px-3 py-1 text-xs font-semibold text-amber-900">
            Review →
          </span>
        </Link>
      )}

      <PageHeader
        title="Master dashboard"
        description="Aggregated across every active client."
        actions={
          <>
            <Button asChild variant="outline" size="sm">
              <Link href="/clients/new">
                <Plus className="mr-1.5 h-4 w-4" /> New client
              </Link>
            </Button>
            <Button asChild variant="outline" size="sm">
              <Link href="/leads/import">
                <Upload className="mr-1.5 h-4 w-4" /> Import leads
              </Link>
            </Button>
            <Button asChild size="sm">
              <Link href="/campaigns/new">
                <Send className="mr-1.5 h-4 w-4" /> Launch campaign
              </Link>
            </Button>
          </>
        }
      />

      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        {stats.map((s) => (
          <Card key={s.label}>
            <CardHeader className="pb-2">
              <CardTitle className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                {s.label}
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-semibold">{s.value}</div>
            </CardContent>
          </Card>
        ))}
      </div>

      <div className="mt-8">
        <SalesFunnel
          clientOptions={clientOptions}
          selectedClientId={selectedClientId}
          stages={funnelStages}
          counts={funnelCounts}
          leadsByStage={funnelLeadsByStage}
        />
      </div>

      <div className="mt-8">
        <h2 className="mb-3 text-sm font-medium uppercase tracking-wider text-muted-foreground">
          Live activity
        </h2>
        <Card>
          <CardContent className="p-0">
            {!recentEvents || recentEvents.length === 0 ? (
              <p className="px-6 py-12 text-center text-sm text-muted-foreground">
                No events yet — kick off a campaign or import leads to start the loop.
              </p>
            ) : (
              <ul className="divide-y">
                {recentEvents.map((e) => {
                  const fe = describeEvent(e as Pick<AppEvent, "event_type" | "payload">);
                  return (
                    <li
                      key={e.id}
                      className="flex items-center justify-between gap-4 px-6 py-3 text-sm"
                    >
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${statusDot(fe.status)}`} />
                          <span className="truncate font-medium">{fe.headline}</span>
                          {fe.source && (
                            <span className="shrink-0 rounded-full border border-border/60 bg-muted/40 px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                              {fe.source}
                            </span>
                          )}
                        </div>
                        {fe.detail && (
                          <span className="ml-3.5 mt-0.5 block truncate text-xs text-muted-foreground">
                            {fe.detail}
                          </span>
                        )}
                      </div>
                      <span className="shrink-0 text-xs text-muted-foreground">
                        {formatDateTime(e.created_at)}
                      </span>
                    </li>
                  );
                })}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>
    </>
  );
}

function statusDot(status: "ok" | "warn" | "fail" | "info"): string {
  switch (status) {
    case "ok":
      return "bg-emerald-500";
    case "warn":
      return "bg-amber-500";
    case "fail":
      return "bg-rose-500";
    default:
      return "bg-muted-foreground/40";
  }
}
