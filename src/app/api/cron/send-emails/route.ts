import { NextResponse, type NextRequest } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { resend, FROM_EMAIL } from "@/lib/resend";
import { logEvent } from "@/lib/events";
import type { SequenceStep } from "@/lib/supabase/types";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Hourly cron — runs from vercel.json or any external scheduler.
 *
 * Per email row in `emails` with status='pending' and send_at <= now():
 *   1. If lead is unsubscribed or won → cancel this + any later steps for this lead+campaign.
 *   2. If lead has replied (any inbound email exists) → cancel remaining steps.
 *   3. Otherwise: send via Resend. On success:
 *      - update email row: status='sent', sent_at=now, resend_message_id
 *      - mark lead.last_contacted_at, stage='contacted' if currently 'new'
 *      - log email_sent event
 *      - queue the next step's email row with send_at = now + delay_days, if one exists
 *   4. On failure: status='failed', log + leave alone (no retry — operator can re-enrol).
 *
 * Auth via Authorization: Bearer ${CRON_SECRET}. Vercel cron supplies this header automatically
 * when the route is configured in vercel.json.
 */
export async function GET(req: NextRequest) {
  if (process.env.CRON_SECRET) {
    const auth = req.headers.get("authorization");
    if (auth !== `Bearer ${process.env.CRON_SECRET}`) {
      return new NextResponse("Unauthorized", { status: 401 });
    }
  }

  const supabase = createServiceClient();
  const nowIso = new Date().toISOString();

  // Pull a batch — keep it conservative so a single hourly run doesn't blow timeouts.
  const { data: pending, error } = await supabase
    .from("emails")
    .select("*, leads(id, email, stage, company_name, contact_name, last_contacted_at, client_id), campaigns(id, name, sequence_steps, status)")
    .eq("status", "pending")
    .lte("send_at", nowIso)
    .order("send_at", { ascending: true })
    .limit(100);

  if (error) {
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }
  if (!pending || pending.length === 0) {
    return NextResponse.json({ ok: true, processed: 0, sent: 0, skipped: 0 });
  }

  let sent = 0;
  let skipped = 0;
  let failed = 0;

  for (const row of pending as PendingEmail[]) {
    const lead = row.leads;
    const campaign = row.campaigns;

    if (!lead || !lead.email) {
      await markFailed(row.id, "missing lead/email");
      failed++;
      continue;
    }

    if (lead.stage === "unsubscribed" || lead.stage === "won" || lead.stage === "lost") {
      await cancelRemaining(row, "stage_blocked");
      skipped++;
      continue;
    }

    if (campaign?.status && campaign.status !== "active") {
      await markFailed(row.id, `campaign ${campaign.status}`);
      skipped++;
      continue;
    }

    // Has the lead already replied (any inbound email exists for this lead+campaign)?
    const { data: replyExists } = await supabase
      .from("emails")
      .select("id")
      .eq("lead_id", lead.id)
      .eq("direction", "inbound")
      .limit(1)
      .maybeSingle();
    if (replyExists) {
      await cancelRemaining(row, "lead_replied");
      skipped++;
      continue;
    }

    // Send via Resend
    try {
      const result = await resend.emails.send({
        from: FROM_EMAIL,
        to: lead.email,
        subject: row.subject ?? "",
        text: row.body ?? "",
        replyTo: FROM_EMAIL,
      });
      if (result.error) throw new Error(result.error.message);

      await supabase
        .from("emails")
        .update({
          status: "sent",
          sent_at: new Date().toISOString(),
          resend_message_id: result.data?.id ?? null,
        })
        .eq("id", row.id);

      await supabase
        .from("leads")
        .update({
          last_contacted_at: new Date().toISOString(),
          stage: lead.stage === "new" ? "contacted" : (lead.stage as "contacted"),
        })
        .eq("id", lead.id);

      await logEvent({
        service: true,
        event_type: "email_sent",
        lead_id: lead.id,
        client_id: row.client_id,
        campaign_id: row.campaign_id,
        payload: {
          lead_name: lead.company_name,
          subject: row.subject,
          step_number: row.step_number,
          resend_message_id: result.data?.id ?? null,
        },
      });

      // Queue next step
      if (campaign?.sequence_steps && row.step_number != null) {
        const steps = campaign.sequence_steps as SequenceStep[];
        const next = steps.find((s) => s.step === (row.step_number as number) + 1);
        if (next) {
          const sendAt = new Date(Date.now() + next.delay_days * 24 * 60 * 60 * 1000).toISOString();
          await supabase.from("emails").insert({
            lead_id: lead.id,
            client_id: row.client_id,
            campaign_id: row.campaign_id,
            direction: "outbound",
            step_number: next.step,
            subject: substitute(next.subject, lead),
            body: substitute(next.body, lead),
            status: "pending",
            send_at: sendAt,
          });
        }
      }

      sent++;
    } catch (err) {
      console.error("[cron/send-emails] send failed", err);
      await markFailed(row.id, err instanceof Error ? err.message : String(err));
      failed++;
    }
  }

  return NextResponse.json({ ok: true, processed: pending.length, sent, skipped, failed });

  // ----- helpers (closures so we capture supabase) -----

  async function markFailed(id: string, reason: string) {
    await supabase.from("emails").update({ status: "failed" }).eq("id", id);
    await logEvent({
      service: true,
      event_type: "ai_action",
      payload: { kind: "email_failed", email_id: id, reason },
    });
  }

  async function cancelRemaining(row: PendingEmail, reason: string) {
    await supabase.from("emails").update({ status: "failed" }).eq("id", row.id);
    if (row.lead_id && row.campaign_id) {
      await supabase
        .from("emails")
        .update({ status: "failed" })
        .eq("lead_id", row.lead_id)
        .eq("campaign_id", row.campaign_id)
        .eq("status", "pending");
    }
    await logEvent({
      service: true,
      event_type: "ai_action",
      lead_id: row.lead_id,
      campaign_id: row.campaign_id,
      payload: { kind: "sequence_cancelled", reason },
    });
  }
}

type PendingEmail = {
  id: string;
  lead_id: string | null;
  client_id: string | null;
  campaign_id: string | null;
  step_number: number | null;
  subject: string | null;
  body: string | null;
  send_at: string | null;
  leads: {
    id: string;
    email: string | null;
    stage: string;
    company_name: string;
    contact_name: string | null;
    last_contacted_at: string | null;
    client_id: string | null;
  } | null;
  campaigns: {
    id: string;
    name: string;
    sequence_steps: SequenceStep[] | null;
    status: string;
  } | null;
};

function substitute(template: string, lead: { contact_name?: string | null; company_name?: string | null }): string {
  return template
    .replace(/\{\{\s*contact_name\s*\}\}/gi, lead.contact_name?.split(" ")[0] ?? "there")
    .replace(/\{\{\s*company_name\s*\}\}/gi, lead.company_name ?? "your team");
}
