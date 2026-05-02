import { createClient } from "@/lib/supabase/server";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { PageHeader } from "@/components/page-header";
import { formatDateTime, formatCurrency } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import Link from "next/link";
import { Plus, Upload, Send } from "lucide-react";

export const dynamic = "force-dynamic";

export default async function DashboardPage() {
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

  return (
    <>
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
                {recentEvents.map((e) => (
                  <li key={e.id} className="flex items-center justify-between gap-4 px-6 py-3 text-sm">
                    <div>
                      <span className="font-medium">{e.event_type}</span>
                      {e.payload && Object.keys(e.payload as object).length > 0 && (
                        <span className="ml-2 text-muted-foreground">
                          {summarisePayload(e.payload as Record<string, unknown>)}
                        </span>
                      )}
                    </div>
                    <span className="shrink-0 text-xs text-muted-foreground">
                      {formatDateTime(e.created_at)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>
    </>
  );
}

function summarisePayload(payload: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const key of ["lead_name", "company_name", "client_name", "campaign_name", "subject", "from"]) {
    if (typeof payload[key] === "string") parts.push(`${key}: ${payload[key]}`);
    if (parts.length >= 2) break;
  }
  return parts.join(" · ");
}
