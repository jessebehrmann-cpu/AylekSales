import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { PageHeader } from "@/components/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

export const dynamic = "force-dynamic";

export default async function CampaignDetailPage({ params }: { params: { id: string } }) {
  const supabase = createClient();
  const { data: campaign } = await supabase
    .from("campaigns")
    .select("*")
    .eq("id", params.id)
    .maybeSingle();

  if (!campaign) notFound();

  const steps = (campaign.sequence_steps ?? []) as Array<{ step: number; subject: string; body: string; delay_days: number }>;

  return (
    <>
      <PageHeader
        title={campaign.name}
        description={[campaign.target_title, campaign.target_industry].filter(Boolean).join(" @ ")}
        actions={<Badge variant={campaign.status === "active" ? "success" : "muted"}>{campaign.status}</Badge>}
      />
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Sequence ({steps.length} step{steps.length === 1 ? "" : "s"})</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {steps.length === 0 ? (
            <p className="text-sm text-muted-foreground">No sequence steps yet.</p>
          ) : (
            steps.map((s) => (
              <div key={s.step} className="rounded border p-4">
                <div className="text-xs uppercase text-muted-foreground">
                  Step {s.step} · day {s.delay_days}
                </div>
                <p className="mt-1 font-medium">{s.subject}</p>
                <p className="mt-2 whitespace-pre-line text-sm text-muted-foreground">{s.body}</p>
              </div>
            ))
          )}
        </CardContent>
      </Card>
    </>
  );
}
