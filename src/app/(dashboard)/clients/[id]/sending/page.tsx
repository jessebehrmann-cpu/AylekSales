import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { requireUser } from "@/lib/auth";
import { PageHeader } from "@/components/page-header";
import { Card, CardContent } from "@/components/ui/card";
import { SendingClient } from "./sending-client";
import type { Client } from "@/lib/supabase/types";

export const dynamic = "force-dynamic";

export default async function ClientSendingPage({ params }: { params: { id: string } }) {
  const user = await requireUser();
  if (user.profile?.role !== "admin") {
    return (
      <PageHeader title="Sending domain" description="Admins only — ask your HOS to configure this." />
    );
  }
  const supabase = createClient();
  const { data } = await supabase.from("clients").select("*").eq("id", params.id).maybeSingle();
  const client = (data as Client | null) ?? null;
  if (!client) notFound();
  return (
    <>
      <PageHeader
        title={`${client.name} — sending domain`}
        description="Per-client Resend domain. Required for outbound to send AS this client (not from the shared Aylek address)."
      />
      <Card>
        <CardContent className="pt-6">
          <SendingClient clientId={client.id} initialConfig={client.email_config} />
        </CardContent>
      </Card>
    </>
  );
}
