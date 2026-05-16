import { notFound } from "next/navigation";
import { createServiceClient } from "@/lib/supabase/server";
import { logEvent } from "@/lib/events";
import type { SuppressedEmail } from "@/lib/supabase/types";

export const dynamic = "force-dynamic";

/**
 * Public unsubscribe landing page. The link in every outbound email
 * points here with a unique token. On hit:
 *   - Promote the row from reason='manual' notes='pending_token' to
 *     reason='unsubscribe' notes=null.
 *   - Find every lead with this email (across ALL clients) and flip
 *     them to stage='unsubscribed'.
 *   - Cancel any pending emails for those leads.
 *
 * No auth — the token itself is the credential. No CSRF risk because
 * the only side effect is suppression (idempotent + always-safe).
 */
export default async function UnsubscribePage({ params }: { params: { token: string } }) {
  const supabase = createServiceClient();

  const { data } = await supabase
    .from("suppressed_emails")
    .select("*")
    .eq("unsubscribe_token", params.token)
    .maybeSingle();
  const row = data as SuppressedEmail | null;
  if (!row) notFound();

  const alreadyDone = row.reason === "unsubscribe";

  if (!alreadyDone) {
    // Promote the row to a real unsubscribe.
    await supabase
      .from("suppressed_emails")
      .update({
        reason: "unsubscribe",
        notes: null,
        suppressed_at: new Date().toISOString(),
      })
      .eq("email", row.email);

    // Flip every lead with this email to unsubscribed + cancel their
    // pending emails.
    const { data: leads } = await supabase
      .from("leads")
      .select("id, client_id, company_name")
      .eq("email", row.email);
    const leadRows = (leads ?? []) as Array<{
      id: string;
      client_id: string | null;
      company_name: string;
    }>;
    if (leadRows.length > 0) {
      const ids = leadRows.map((l) => l.id);
      await supabase
        .from("leads")
        .update({ stage: "unsubscribed" })
        .in("id", ids);
      await supabase
        .from("emails")
        .update({ status: "failed" })
        .in("lead_id", ids)
        .eq("status", "pending");
      for (const lead of leadRows) {
        await logEvent({
          service: true,
          event_type: "stage_changed",
          lead_id: lead.id,
          client_id: lead.client_id,
          payload: {
            kind: "unsubscribed_via_link",
            lead_name: lead.company_name,
            after: "unsubscribed",
          },
        });
      }
    }
  }

  return (
    <main className="min-h-screen bg-background text-foreground">
      <div className="mx-auto max-w-lg px-6 py-24 text-center">
        <h1 className="text-3xl font-semibold tracking-tight">You&apos;re unsubscribed.</h1>
        <p className="mt-4 text-base text-muted-foreground">
          {row.email} won&apos;t hear from us again. Sorry for the noise.
        </p>
        <p className="mt-8 text-xs text-muted-foreground">
          {alreadyDone
            ? "Already on the list — nothing changed."
            : "You can close this tab."}
        </p>
      </div>
    </main>
  );
}
