import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { formatCurrency } from "@/lib/utils";

export const dynamic = "force-dynamic";

export default async function ClientDetailPage({ params }: { params: { id: string } }) {
  const supabase = createClient();
  const { data: client } = await supabase.from("clients").select("*").eq("id", params.id).maybeSingle();

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
            <p className="mt-1 text-xl font-semibold">{formatCurrency(client.retainer_amount)}</p>
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
            <p className="text-xs uppercase text-muted-foreground">Contact</p>
            <p className="mt-1 text-sm">{client.email ?? "—"}</p>
            <p className="text-sm text-muted-foreground">{client.phone ?? ""}</p>
          </CardContent>
        </Card>
      </div>
      <p className="mt-8 text-sm text-muted-foreground">
        Scoped workspace (leads, campaigns, inbound, meetings filtered to this client) ships in the
        next pass.
      </p>
    </>
  );
}
