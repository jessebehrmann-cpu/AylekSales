import Link from "next/link";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { requireUser } from "@/lib/auth";
import { PageHeader } from "@/components/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { formatCurrency, formatDateTime } from "@/lib/utils";
import { DeleteLeadButton, NoteForm, StagePicker } from "./lead-actions";
import { ApprovalBadge } from "@/components/approval-badge";
import { LeadTimelineCard } from "./lead-timeline";
import type { Lead, Email, Meeting, AppEvent, SalesProcessStage } from "@/lib/supabase/types";
import { inferProcessStageFromLeadStage } from "@/lib/playbook-defaults";

export const dynamic = "force-dynamic";

type LeadWithClient = Lead & { clients: { name: string } | null };

export default async function LeadDetailPage({ params }: { params: { id: string } }) {
  await requireUser();
  const supabase = createClient();

  const [leadRes, eventsRes, emailsRes, meetingsRes] = await Promise.all([
    supabase.from("leads").select("*, clients(name)").eq("id", params.id).maybeSingle(),
    supabase.from("events").select("*").eq("lead_id", params.id).order("created_at", { ascending: false }).limit(50),
    supabase.from("emails").select("*").eq("lead_id", params.id).order("created_at", { ascending: false }),
    supabase.from("meetings").select("*").eq("lead_id", params.id).order("scheduled_at", { ascending: true }),
  ]);

  const lead = leadRes.data as unknown as LeadWithClient | null;
  const events = eventsRes.data as AppEvent[] | null;
  const emails = emailsRes.data as Email[] | null;
  const meetings = meetingsRes.data as Meeting[] | null;

  if (!lead) notFound();

  const clientName = lead.clients?.name;

  // Pull the client's approved playbook so we can render the sales-process
  // timeline at the top of the page.
  let processStages: SalesProcessStage[] = [];
  if (lead.client_id) {
    const { data: pbRow } = await supabase
      .from("playbooks")
      .select("sales_process")
      .eq("client_id", lead.client_id)
      .eq("status", "approved")
      .maybeSingle();
    processStages = ((pbRow as { sales_process?: SalesProcessStage[] } | null)?.sales_process ?? []) as SalesProcessStage[];
  }
  const inferredStageId =
    lead.process_stage_id ?? inferProcessStageFromLeadStage(lead.stage, processStages);

  return (
    <>
      <PageHeader
        title={lead.company_name}
        description={
          [lead.contact_name, lead.title, clientName ? `client: ${clientName}` : null]
            .filter(Boolean)
            .join(" · ") || undefined
        }
        actions={
          <div className="flex items-center gap-3">
            <ApprovalBadge status={lead.approval_status} />
            <StagePicker leadId={lead.id} current={lead.stage} />
            <DeleteLeadButton leadId={lead.id} />
          </div>
        }
      />

      {processStages.length > 0 && (
        <LeadTimelineCard
          leadId={lead.id}
          stages={processStages}
          currentStageId={inferredStageId}
          leadStage={lead.stage}
          isExplicit={lead.process_stage_id != null}
        />
      )}

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Email thread ({emails?.length ?? 0})</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              {!emails || emails.length === 0 ? (
                <p className="text-sm text-muted-foreground">No emails yet.</p>
              ) : (
                emails.map((e) => (
                  <div key={e.id} className="rounded border p-3 text-sm">
                    <div className="flex items-center justify-between text-xs text-muted-foreground">
                      <span>
                        {e.direction === "inbound" ? "← inbound" : "→ outbound"} · {e.status}
                        {e.step_number != null && ` · step ${e.step_number}`}
                      </span>
                      <span>{formatDateTime(e.sent_at ?? e.created_at)}</span>
                    </div>
                    <p className="mt-1 font-medium">{e.subject ?? "(no subject)"}</p>
                    {e.body && (
                      <p className="mt-2 whitespace-pre-line text-muted-foreground">{e.body}</p>
                    )}
                    {e.reply_body && (
                      <div className="mt-2 rounded bg-muted px-2 py-1.5">
                        <p className="text-xs uppercase text-muted-foreground">Reply:</p>
                        <p className="whitespace-pre-line">{e.reply_body}</p>
                      </div>
                    )}
                  </div>
                ))
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader><CardTitle className="text-base">Activity ({events?.length ?? 0})</CardTitle></CardHeader>
            <CardContent>
              {!events || events.length === 0 ? (
                <p className="text-sm text-muted-foreground">No events yet.</p>
              ) : (
                <ul className="divide-y">
                  {events.map((e) => (
                    <li key={e.id} className="flex items-start justify-between gap-4 py-2 text-sm">
                      <div>
                        <span className="font-medium">{e.event_type}</span>
                        {e.payload && Object.keys(e.payload as object).length > 0 && (
                          <p className="text-xs text-muted-foreground">{summarisePayload(e.payload as Record<string, unknown>)}</p>
                        )}
                      </div>
                      <span className="shrink-0 text-xs text-muted-foreground">{formatDateTime(e.created_at)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader><CardTitle className="text-base">Add note</CardTitle></CardHeader>
            <CardContent><NoteForm leadId={lead.id} /></CardContent>
          </Card>
        </div>

        <div className="space-y-6">
          <Card>
            <CardHeader><CardTitle className="text-base">Contact</CardTitle></CardHeader>
            <CardContent className="space-y-2 text-sm">
              <Row label="Email" value={lead.email} />
              <Row label="Phone" value={lead.phone} />
              <Row label="Suburb" value={lead.suburb} />
              <Row label="Industry" value={lead.industry} />
              <Row label="Employees" value={lead.employees_estimate?.toString()} />
              <Row label="Website" value={lead.website} />
              <Row label="Source" value={lead.source} />
              <Row label="Value" value={formatCurrency(lead.contract_value)} />
              <Row label="Last contacted" value={lead.last_contacted_at ? formatDateTime(lead.last_contacted_at) : null} />
            </CardContent>
          </Card>

          {meetings && meetings.length > 0 && (
            <Card>
              <CardHeader><CardTitle className="text-base">Meetings</CardTitle></CardHeader>
              <CardContent className="space-y-2 text-sm">
                {meetings.map((m) => (
                  <div key={m.id} className="flex items-center justify-between">
                    <span>{formatDateTime(m.scheduled_at)}</span>
                    <Badge variant="muted">{m.status}</Badge>
                  </div>
                ))}
              </CardContent>
            </Card>
          )}

          {lead.notes && (
            <Card>
              <CardHeader><CardTitle className="text-base">Notes</CardTitle></CardHeader>
              <CardContent>
                <pre className="whitespace-pre-wrap text-sm text-muted-foreground">{lead.notes}</pre>
              </CardContent>
            </Card>
          )}

          {clientName && (
            <Link
              href={`/clients/${lead.client_id}`}
              className="block rounded border bg-card p-4 text-sm hover:bg-muted"
            >
              <p className="text-xs uppercase text-muted-foreground">Client</p>
              <p className="mt-1 font-medium">{clientName}</p>
            </Link>
          )}
        </div>
      </div>
    </>
  );
}

function Row({ label, value }: { label: string; value: string | null | undefined }) {
  return (
    <div className="flex justify-between gap-4">
      <span className="text-muted-foreground">{label}</span>
      <span className="text-right">{value || "—"}</span>
    </div>
  );
}

function summarisePayload(payload: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(payload)) {
    if (typeof v === "string" || typeof v === "number") {
      parts.push(`${k}: ${v}`);
      if (parts.length >= 3) break;
    }
  }
  return parts.join(" · ");
}
