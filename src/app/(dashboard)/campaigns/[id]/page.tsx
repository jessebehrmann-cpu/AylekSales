import { notFound } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { PageHeader } from "@/components/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { PauseButton } from "./pause-button";
import { formatDateTime } from "@/lib/utils";
import type { Campaign, SequenceStep } from "@/lib/supabase/types";

export const dynamic = "force-dynamic";

type CampaignWithClient = Campaign & { clients: { name: string } | null };

export default async function CampaignDetailPage({ params }: { params: { id: string } }) {
  const supabase = createClient();

  const [campaignRes, emailStats] = await Promise.all([
    supabase.from("campaigns").select("*, clients(name)").eq("id", params.id).maybeSingle(),
    Promise.all([
      supabase.from("emails").select("id", { count: "exact", head: true }).eq("campaign_id", params.id),
      supabase.from("emails").select("id", { count: "exact", head: true }).eq("campaign_id", params.id).not("sent_at", "is", null),
      supabase.from("emails").select("id", { count: "exact", head: true }).eq("campaign_id", params.id).not("opened_at", "is", null),
      supabase.from("emails").select("id", { count: "exact", head: true }).eq("campaign_id", params.id).not("replied_at", "is", null),
      supabase.from("meetings").select("id", { count: "exact", head: true }).gte("created_at", "1900-01-01"), // total meetings; not perfectly campaign-attributed
    ]),
  ]);

  const campaign = campaignRes.data as unknown as CampaignWithClient | null;
  if (!campaign) notFound();
  const [{ count: total }, { count: sent }, { count: opened }, { count: replied }] = emailStats;

  const steps = (campaign.sequence_steps ?? []) as SequenceStep[];
  const clientName = campaign.clients?.name;
  const replyRate = sent && sent > 0 ? ((replied ?? 0) / sent) * 100 : null;
  const openRate = sent && sent > 0 ? ((opened ?? 0) / sent) * 100 : null;

  return (
    <>
      <PageHeader
        title={campaign.name}
        description={[
          clientName ? `client: ${clientName}` : null,
          campaign.target_title,
          campaign.target_industry,
        ].filter(Boolean).join(" · ")}
        actions={
          <div className="flex items-center gap-2">
            <Badge variant={campaign.status === "active" ? "success" : "muted"}>{campaign.status}</Badge>
            {campaign.status === "active" && <PauseButton campaignId={campaign.id} />}
          </div>
        }
      />

      <div className="grid grid-cols-2 gap-4 md:grid-cols-5">
        <Stat label="Enrolled" value={campaign.leads_enrolled} />
        <Stat label="Emails queued" value={total ?? 0} />
        <Stat label="Sent" value={sent ?? 0} />
        <Stat label="Open rate" value={openRate == null ? "—" : `${openRate.toFixed(1)}%`} />
        <Stat label="Reply rate" value={replyRate == null ? "—" : `${replyRate.toFixed(1)}%`} />
      </div>

      <div className="mt-8">
        <h2 className="mb-3 text-sm font-medium uppercase tracking-wider text-muted-foreground">
          Sequence ({steps.length} step{steps.length === 1 ? "" : "s"})
        </h2>
        {steps.length === 0 ? (
          <p className="text-sm text-muted-foreground">No sequence steps yet.</p>
        ) : (
          <div className="space-y-3">
            {steps.map((s) => (
              <Card key={s.step}>
                <CardHeader className="pb-2">
                  <CardTitle className="flex items-center justify-between text-sm">
                    <span>Step {s.step}</span>
                    <span className="text-xs font-normal text-muted-foreground">day {s.delay_days}</span>
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <p className="font-medium">{s.subject}</p>
                  <p className="mt-2 whitespace-pre-line text-sm text-muted-foreground">{s.body}</p>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </div>

      <p className="mt-8 text-xs text-muted-foreground">
        Created {formatDateTime(campaign.created_at)} ·{" "}
        <Link href={`/leads?client=${campaign.client_id}`} className="text-primary hover:underline">view all client leads</Link>
      </p>
    </>
  );
}

function Stat({ label, value }: { label: string; value: number | string }) {
  return (
    <Card>
      <CardContent className="pt-5">
        <p className="text-xs uppercase text-muted-foreground">{label}</p>
        <p className="mt-1 text-xl font-semibold">{value}</p>
      </CardContent>
    </Card>
  );
}
