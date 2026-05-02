import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatCurrency, formatDateTime } from "@/lib/utils";

export const dynamic = "force-dynamic";

export default async function LeadDetailPage({ params }: { params: { id: string } }) {
  const supabase = createClient();

  const [{ data: lead }, { data: events }, { data: emails }] = await Promise.all([
    supabase.from("leads").select("*").eq("id", params.id).maybeSingle(),
    supabase.from("events").select("*").eq("lead_id", params.id).order("created_at", { ascending: false }),
    supabase.from("emails").select("*").eq("lead_id", params.id).order("created_at", { ascending: false }),
  ]);

  if (!lead) notFound();

  return (
    <>
      <PageHeader
        title={lead.company_name}
        description={[lead.contact_name, lead.title].filter(Boolean).join(" · ") || undefined}
        actions={<Badge>{lead.stage}</Badge>}
      />
      <div className="grid gap-6 md:grid-cols-3">
        <div className="space-y-4 md:col-span-2">
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
                      <span>{e.direction === "inbound" ? "← inbound" : "→ outbound"} · {e.status}</span>
                      <span>{formatDateTime(e.sent_at ?? e.created_at)}</span>
                    </div>
                    <p className="mt-1 font-medium">{e.subject ?? "(no subject)"}</p>
                  </div>
                ))
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Activity ({events?.length ?? 0})</CardTitle>
            </CardHeader>
            <CardContent>
              {!events || events.length === 0 ? (
                <p className="text-sm text-muted-foreground">No events yet.</p>
              ) : (
                <ul className="divide-y">
                  {events.map((e) => (
                    <li key={e.id} className="flex items-center justify-between py-2 text-sm">
                      <span>{e.event_type}</span>
                      <span className="text-xs text-muted-foreground">{formatDateTime(e.created_at)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
        </div>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Contact</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <Row label="Email" value={lead.email} />
            <Row label="Phone" value={lead.phone} />
            <Row label="Suburb" value={lead.suburb} />
            <Row label="Industry" value={lead.industry} />
            <Row label="Employees" value={lead.employees_estimate?.toString()} />
            <Row label="Website" value={lead.website} />
            <Row label="Value" value={formatCurrency(lead.contract_value)} />
          </CardContent>
        </Card>
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
