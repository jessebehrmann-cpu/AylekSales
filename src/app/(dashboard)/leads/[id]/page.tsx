import Link from "next/link";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { requireUser } from "@/lib/auth";
import { PageHeader } from "@/components/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { formatCurrency, formatDateTime } from "@/lib/utils";
import { NoteForm } from "./lead-actions";
import { LeadDetailHeaderActions } from "./lead-detail-header";
import { LeadTimelineCard } from "./lead-timeline";
import { CommunicationHistory } from "./communication-history";
import type { Lead, Email, Meeting, AppEvent, MeetingNote, SalesProcessStage } from "@/lib/supabase/types";
import { inferProcessStageFromLeadStage, isHumanStage } from "@/lib/playbook-defaults";

export const dynamic = "force-dynamic";

type LeadWithClient = Lead & { clients: { name: string } | null };

export default async function LeadDetailPage({ params }: { params: { id: string } }) {
  await requireUser();
  const supabase = createClient();

  const [leadRes, eventsRes, emailsRes, meetingsRes, meetingNotesRes] = await Promise.all([
    supabase.from("leads").select("*, clients(name)").eq("id", params.id).maybeSingle(),
    supabase.from("events").select("*").eq("lead_id", params.id).order("created_at", { ascending: false }).limit(200),
    supabase.from("emails").select("*").eq("lead_id", params.id).order("created_at", { ascending: false }),
    supabase.from("meetings").select("*").eq("lead_id", params.id).order("scheduled_at", { ascending: true }),
    supabase.from("meeting_notes").select("*").eq("lead_id", params.id).order("created_at", { ascending: false }),
  ]);

  const lead = leadRes.data as unknown as LeadWithClient | null;
  const events = eventsRes.data as AppEvent[] | null;
  const emails = emailsRes.data as Email[] | null;
  const meetings = meetingsRes.data as Meeting[] | null;
  const meetingNotes = meetingNotesRes.data as MeetingNote[] | null;

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
  const currentStage = inferredStageId
    ? processStages.find((s) => s.id === inferredStageId) ?? null
    : null;
  const onHumanStage = currentStage ? isHumanStage(currentStage.agent) : false;

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
          <LeadDetailHeaderActions
            leadId={lead.id}
            approvalStatus={lead.approval_status}
            leadStage={lead.stage}
            currentStage={currentStage}
            onHumanStage={onHumanStage}
          />
        }
      />

      {onHumanStage && currentStage && (
        <Alert className="mb-4 border-amber-300 bg-amber-50 text-amber-900">
          <strong>Automation paused:</strong> {currentStage.name} is owned by a human in
          the loop. Pending outreach for this lead is on hold until you mark the stage complete.
        </Alert>
      )}

      {processStages.length > 0 && (
        <LeadTimelineCard
          stages={processStages}
          currentStageId={inferredStageId}
          leadStage={lead.stage}
          isExplicit={lead.process_stage_id != null}
        />
      )}

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          <CommunicationHistory
            emails={emails ?? []}
            events={events ?? []}
            meetings={meetings ?? []}
            meetingNotes={meetingNotes ?? []}
          />

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
