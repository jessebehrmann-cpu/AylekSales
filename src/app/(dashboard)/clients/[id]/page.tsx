import Link from "next/link";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { requireUser } from "@/lib/auth";
import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { formatCurrency, formatDateTime } from "@/lib/utils";
import { EditClientForm } from "./edit-client-form";
import { ExternalLink, Users, Send } from "lucide-react";

export const dynamic = "force-dynamic";

export default async function ClientDetailPage({ params }: { params: { id: string } }) {
  const user = await requireUser();
  const isAdmin = user.profile?.role === "admin";

  const supabase = createClient();
  const [{ data: client }, { data: leads }, { data: campaigns }, { data: events }] = await Promise.all([
    supabase.from("clients").select("*").eq("id", params.id).maybeSingle(),
    supabase
      .from("leads")
      .select("id, company_name, contact_name, stage")
      .eq("client_id", params.id)
      .order("created_at", { ascending: false })
      .limit(8),
    supabase
      .from("campaigns")
      .select("id, name, status, leads_enrolled")
      .eq("client_id", params.id)
      .order("created_at", { ascending: false })
      .limit(5),
    supabase
      .from("events")
      .select("event_type, payload, created_at")
      .eq("client_id", params.id)
      .order("created_at", { ascending: false })
      .limit(20),
  ]);

  if (!client) notFound();

  return (
    <>
      <PageHeader
        title={client.name}
        description={[client.suburb, client.owner_name].filter(Boolean).join(" · ") || undefined}
        actions={<Badge variant={client.status === "active" ? "success" : "muted"}>{client.status}</Badge>}
      />

      <div className="grid gap-4 md:grid-cols-3">
        <Card>
          <CardContent className="pt-6">
            <p className="text-xs uppercase text-muted-foreground">Retainer</p>
            <p className="mt-1 text-xl font-semibold">{formatCurrency(client.retainer_amount)}/mo</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            <p className="text-xs uppercase text-muted-foreground">Revenue share</p>
            <p className="mt-1 text-xl font-semibold">{client.revenue_share_pct}%</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            <p className="text-xs uppercase text-muted-foreground">Billing</p>
            {client.stripe_customer_id ? (
              <Link
                href={`https://dashboard.stripe.com/${client.stripe_customer_id.startsWith("cus_test") ? "test/" : ""}customers/${client.stripe_customer_id}`}
                target="_blank"
                rel="noreferrer"
                className="mt-1 flex items-center gap-1 text-sm font-medium text-primary hover:underline"
              >
                Open billing dashboard <ExternalLink className="h-3 w-3" />
              </Link>
            ) : (
              <p className="mt-1 text-sm text-muted-foreground">Not linked</p>
            )}
          </CardContent>
        </Card>
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-3">
        <div className="lg:col-span-2">
          {isAdmin ? (
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Edit details</CardTitle>
              </CardHeader>
              <CardContent>
                <EditClientForm client={client} />
              </CardContent>
            </Card>
          ) : (
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Details</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2 text-sm">
                <Row label="Email" value={client.email} />
                <Row label="Phone" value={client.phone} />
                <Row label="Owner" value={client.owner_name} />
              </CardContent>
            </Card>
          )}

          {events && events.length > 0 && (
            <Card className="mt-6">
              <CardHeader><CardTitle className="text-base">Recent activity</CardTitle></CardHeader>
              <CardContent>
                <ul className="divide-y">
                  {events.map((e, i) => (
                    <li key={i} className="flex items-center justify-between py-2 text-sm">
                      <span>{e.event_type}</span>
                      <span className="text-xs text-muted-foreground">{formatDateTime(e.created_at)}</span>
                    </li>
                  ))}
                </ul>
              </CardContent>
            </Card>
          )}
        </div>

        <div className="space-y-6">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0">
              <CardTitle className="text-base flex items-center gap-2"><Users className="h-4 w-4" /> Leads</CardTitle>
              <Button asChild variant="outline" size="sm"><Link href={`/leads?client=${client.id}`}>View all</Link></Button>
            </CardHeader>
            <CardContent className="space-y-2 text-sm">
              {!leads || leads.length === 0 ? (
                <p className="text-muted-foreground">None yet.</p>
              ) : (
                leads.map((l) => (
                  <Link key={l.id} href={`/leads/${l.id}`} className="flex items-center justify-between rounded p-2 hover:bg-muted">
                    <span className="font-medium">{l.company_name}</span>
                    <Badge variant="muted">{l.stage}</Badge>
                  </Link>
                ))
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0">
              <CardTitle className="text-base flex items-center gap-2"><Send className="h-4 w-4" /> Campaigns</CardTitle>
              <Button asChild variant="outline" size="sm"><Link href={`/campaigns/new?client=${client.id}`}>New</Link></Button>
            </CardHeader>
            <CardContent className="space-y-2 text-sm">
              {!campaigns || campaigns.length === 0 ? (
                <p className="text-muted-foreground">None yet.</p>
              ) : (
                campaigns.map((c) => (
                  <Link key={c.id} href={`/campaigns/${c.id}`} className="flex items-center justify-between rounded p-2 hover:bg-muted">
                    <span className="font-medium">{c.name}</span>
                    <span className="text-xs text-muted-foreground">{c.leads_enrolled} enrolled · {c.status}</span>
                  </Link>
                ))
              )}
            </CardContent>
          </Card>
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
