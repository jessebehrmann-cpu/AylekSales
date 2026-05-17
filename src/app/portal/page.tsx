import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { requireUser } from "@/lib/auth";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Alert } from "@/components/ui/alert";
import { formatDateTime, formatCurrency } from "@/lib/utils";
import type {
  AppEvent,
  Approval,
  Client,
  Lead,
  SalesProcessStage,
} from "@/lib/supabase/types";
import { inferProcessStageFromLeadStage } from "@/lib/playbook-defaults";
import { describeEvent } from "@/lib/event-format";

export const dynamic = "force-dynamic";

/**
 * Per-client read-only dashboard for client_owner users. Shows:
 *   - Sourcing summary per client they own
 *   - Open approvals (visibility only — no decision UI)
 *   - Recent activity
 *   - Pipeline funnel summary
 *
 * For admins this page renders the same view scoped to whichever
 * clients the admin has client_ids for — empty array (the admin
 * default) shows ALL clients. Admins should normally use /dashboard.
 */
export default async function PortalPage() {
  const u = await requireUser();
  const supabase = createClient();

  // RLS already scopes these queries — admins see all, client_owner
  // sees only their own client_ids.
  const [
    { data: clients },
    { data: leads },
    { data: approvals },
    { data: events },
  ] = await Promise.all([
    supabase.from("clients").select("id, name, status").order("name"),
    supabase
      .from("leads")
      .select("id, client_id, company_name, stage, contract_value, last_contacted_at, contact_name, process_stage_id")
      .order("created_at", { ascending: false })
      .limit(50),
    supabase
      .from("approvals")
      .select("id, type, title, status, client_id, created_at")
      .eq("status", "pending")
      .order("created_at", { ascending: false })
      .limit(10),
    supabase
      .from("events")
      .select("event_type, payload, created_at, client_id")
      .order("created_at", { ascending: false })
      .limit(20),
  ]);

  const clientRows = (clients ?? []) as Pick<Client, "id" | "name" | "status">[];
  const leadRows = (leads ?? []) as Array<
    Pick<Lead, "id" | "client_id" | "company_name" | "stage" | "contract_value" | "last_contacted_at" | "contact_name" | "process_stage_id">
  >;
  const approvalRows = (approvals ?? []) as Array<
    Pick<Approval, "id" | "type" | "title" | "status" | "client_id" | "created_at">
  >;

  if (clientRows.length === 0) {
    return (
      <Alert>
        You&apos;re signed in but don&apos;t have any clients scoped to your account yet. Ask
        your Aylek contact to invite you to the right client.
      </Alert>
    );
  }

  // Group leads by client + by computed stage so we can render mini-funnels.
  const leadsByClient = new Map<string, typeof leadRows>();
  for (const l of leadRows) {
    if (!l.client_id) continue;
    const arr = leadsByClient.get(l.client_id) ?? [];
    arr.push(l);
    leadsByClient.set(l.client_id, arr);
  }

  // Pull approved playbooks for those clients (one round trip) so we
  // can name stages for the funnel summary.
  const stagesByClient = new Map<string, SalesProcessStage[]>();
  const ids = clientRows.map((c) => c.id);
  if (ids.length > 0) {
    const { data: pbs } = await supabase
      .from("playbooks")
      .select("client_id, sales_process")
      .in("client_id", ids)
      .eq("status", "approved");
    for (const row of (pbs ?? []) as Array<{
      client_id: string;
      sales_process: SalesProcessStage[] | null;
    }>) {
      stagesByClient.set(row.client_id, row.sales_process ?? []);
    }
  }

  return (
    <div className="space-y-8">
      <header>
        <h1 className="text-3xl font-semibold tracking-tight">Your sales pipeline</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {u.profile?.role === "admin"
            ? "Admin view — every client you have scope on."
            : "Read-only view of the pipeline Aylek runs on your behalf."}
        </p>
      </header>

      {clientRows.map((client) => {
        const stages = stagesByClient.get(client.id) ?? [];
        const clientLeads = leadsByClient.get(client.id) ?? [];
        const pipelineValue = clientLeads
          .filter((l) => l.stage !== "lost" && l.stage !== "unsubscribed")
          .reduce((sum, l) => sum + (l.contract_value ?? 0), 0);

        const stageCounts = new Map<string, number>();
        for (const l of clientLeads) {
          const sid = l.process_stage_id ?? inferProcessStageFromLeadStage(l.stage, stages);
          if (!sid) continue;
          stageCounts.set(sid, (stageCounts.get(sid) ?? 0) + 1);
        }

        return (
          <section key={client.id} className="space-y-4">
            <div className="flex items-center justify-between gap-3">
              <h2 className="text-xl font-semibold">{client.name}</h2>
              <Badge variant={client.status === "active" ? "success" : "muted"}>
                {client.status}
              </Badge>
            </div>

            <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
              <MetricCard label="Open leads" value={clientLeads.filter((l) => l.stage !== "lost" && l.stage !== "unsubscribed" && l.stage !== "won").length} />
              <MetricCard label="Pipeline value" value={formatCurrency(pipelineValue)} />
              <MetricCard label="Won (lifetime)" value={clientLeads.filter((l) => l.stage === "won").length} />
              <MetricCard label="Open approvals" value={approvalRows.filter((a) => a.client_id === client.id).length} />
            </div>

            {stages.length > 0 && (
              <Card>
                <CardHeader>
                  <CardTitle className="text-base">Pipeline</CardTitle>
                </CardHeader>
                <CardContent>
                  <ul className="space-y-1.5">
                    {stages.map((s, i) => {
                      const count = stageCounts.get(s.id) ?? 0;
                      const max = Math.max(1, ...Array.from(stageCounts.values()));
                      const pct = Math.max(6, (count / max) * 100);
                      return (
                        <li key={s.id} className="flex items-center gap-3 text-sm">
                          <span className="w-32 shrink-0 text-xs font-medium">
                            {i + 1}. {s.name}
                          </span>
                          <span className="flex-1 overflow-hidden rounded-full bg-muted/50">
                            <span
                              className="block h-5 rounded-full bg-primary/60"
                              style={{ width: `${pct}%` }}
                            />
                          </span>
                          <span className="w-8 text-right text-xs font-semibold tabular-nums">
                            {count}
                          </span>
                        </li>
                      );
                    })}
                  </ul>
                </CardContent>
              </Card>
            )}

            {clientLeads.length > 0 && (
              <Card>
                <CardHeader>
                  <CardTitle className="text-base">Most recent leads</CardTitle>
                </CardHeader>
                <CardContent>
                  <ul className="divide-y text-sm">
                    {clientLeads.slice(0, 8).map((l) => (
                      <li key={l.id} className="flex items-center justify-between py-2">
                        <div>
                          <p className="font-medium">{l.company_name}</p>
                          {l.contact_name && (
                            <p className="text-xs text-muted-foreground">{l.contact_name}</p>
                          )}
                        </div>
                        <div className="text-right text-xs text-muted-foreground">
                          <Badge variant="muted">{l.stage}</Badge>
                          {l.last_contacted_at && (
                            <p className="mt-1">{formatDateTime(l.last_contacted_at)}</p>
                          )}
                        </div>
                      </li>
                    ))}
                  </ul>
                </CardContent>
              </Card>
            )}
          </section>
        );
      })}

      {approvalRows.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Pending approvals</CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="divide-y text-sm">
              {approvalRows.map((a) => (
                <li key={a.id} className="flex items-center justify-between py-2">
                  <div>
                    <p className="font-medium">{a.title}</p>
                    <p className="text-xs text-muted-foreground">{a.type}</p>
                  </div>
                  <span className="text-xs text-muted-foreground">{formatDateTime(a.created_at)}</span>
                </li>
              ))}
            </ul>
            <p className="mt-3 text-xs text-muted-foreground">
              Aylek handles these for you — visibility only.
            </p>
          </CardContent>
        </Card>
      )}

      {events && events.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Recent activity</CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="divide-y text-sm">
              {events.slice(0, 10).map((e, i) => {
                const fe = describeEvent(e as Pick<AppEvent, "event_type" | "payload">);
                return (
                  <li key={i} className="flex items-center justify-between py-2 text-xs">
                    <span className="truncate">{fe.headline}</span>
                    <span className="shrink-0 text-muted-foreground">{formatDateTime(e.created_at)}</span>
                  </li>
                );
              })}
            </ul>
          </CardContent>
        </Card>
      )}

      {u.profile?.role === "admin" && (
        <div className="mt-6 text-center text-xs text-muted-foreground">
          <Link href="/dashboard" className="hover:underline">
            ← Back to the admin dashboard
          </Link>
        </div>
      )}
    </div>
  );
}

function MetricCard({ label, value }: { label: string; value: string | number }) {
  return (
    <Card>
      <CardContent className="pt-6">
        <p className="text-[10px] font-medium uppercase tracking-[0.15em] text-muted-foreground">
          {label}
        </p>
        <p className="mt-1 text-2xl font-semibold tabular-nums">{value}</p>
      </CardContent>
    </Card>
  );
}
