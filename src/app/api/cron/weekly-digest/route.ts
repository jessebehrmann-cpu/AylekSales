import { NextResponse, type NextRequest } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { resend, FROM_EMAIL } from "@/lib/resend";
import { getClientSendingConfig } from "@/lib/email-config";
import { collectWeeklyMetrics, draftDigestBody } from "@/lib/digest";
import { logEvent } from "@/lib/events";
import type { Client, Playbook } from "@/lib/supabase/types";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Weekly digest cron — every Monday 09:00 UTC (per vercel.json).
 *
 * For every active client with an owner email:
 *   1. Collect last-7-day metrics
 *   2. Draft an exec summary via Claude (in the client's voice)
 *   3. Send via the per-client Resend domain (Phase 1)
 *
 * Auth: Bearer ${CRON_SECRET}.
 */
export async function GET(req: NextRequest) {
  if (process.env.CRON_SECRET) {
    const auth = req.headers.get("authorization");
    if (auth !== `Bearer ${process.env.CRON_SECRET}`) {
      return new NextResponse("Unauthorized", { status: 401 });
    }
  }

  const supabase = createServiceClient();
  const { data: clients } = await supabase
    .from("clients")
    .select("id, name, owner_name, email, status")
    .eq("status", "active");
  const rows = (clients ?? []) as Pick<Client, "id" | "name" | "owner_name" | "email" | "status">[];

  let sent = 0;
  let skipped = 0;
  const errors: Array<{ client_id: string; error: string }> = [];

  for (const c of rows) {
    if (!c.email) {
      skipped++;
      continue;
    }
    const metrics = await collectWeeklyMetrics(supabase, c.id);
    if (!metrics) {
      skipped++;
      continue;
    }
    // Skip silent weeks — no activity, no email.
    if (
      metrics.leads_sourced + metrics.emails_sent + metrics.replies_received +
        metrics.meetings_booked + metrics.proposals_sent + metrics.deals_won ===
      0
    ) {
      skipped++;
      continue;
    }
    const { data: pbRow } = await supabase
      .from("playbooks")
      .select("*")
      .eq("client_id", c.id)
      .eq("status", "approved")
      .maybeSingle();
    const playbook = (pbRow as Playbook | null) ?? null;
    const draft = await draftDigestBody({ metrics, playbook });
    const sendingCfg = await getClientSendingConfig(supabase, c.id);
    try {
      const result = await resend.emails.send({
        from: sendingCfg.from || FROM_EMAIL,
        to: c.email,
        subject: draft.subject,
        text: draft.body,
        replyTo: sendingCfg.reply_to || FROM_EMAIL,
      });
      if (result.error) throw new Error(result.error.message);
      sent++;
      await logEvent({
        service: true,
        event_type: "ai_action",
        client_id: c.id,
        payload: {
          kind: "weekly_digest_sent",
          metrics,
          warning: draft.warning ?? null,
        },
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push({ client_id: c.id, error: msg });
      console.error(`[weekly-digest] send to ${c.id} failed:`, msg);
    }
  }

  return NextResponse.json({
    ok: true,
    clients: rows.length,
    sent,
    skipped,
    errors,
  });
}
