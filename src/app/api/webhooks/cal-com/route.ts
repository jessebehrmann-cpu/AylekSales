import { NextResponse, type NextRequest } from "next/server";
import { createHmac, timingSafeEqual } from "node:crypto";
import { createServiceClient } from "@/lib/supabase/server";
import { logEvent } from "@/lib/events";
import { normaliseCalWebhook } from "@/lib/calendar/cal-com";
import { transitionLeadToStage } from "@/lib/stage-engine";
import { HAVE_MEETING_STAGE_ID } from "@/lib/playbook-defaults";
import type { Meeting } from "@/lib/supabase/types";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * Cal.com booking webhook handler.
 *
 * Configure at https://app.cal.com/settings/developer/webhooks pointing
 * here. Subscribe to BOOKING_CREATED / RESCHEDULED / CANCELLED. The
 * signing secret is set per-client on clients.calendar_config.webhook_
 * secret — we resolve the client from the booking's metadata.client_id
 * and verify HMAC against THAT client's secret.
 *
 * Falls back to skipping signature verification when no per-client
 * secret is set (dev) but always logs loudly.
 */
export async function POST(req: NextRequest) {
  const raw = await req.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const booking = normaliseCalWebhook(parsed);
  if (!booking) {
    return NextResponse.json({ ok: true, ignored: "not a booking event" });
  }

  const clientId = booking.metadata.client_id ?? null;
  const leadId = booking.metadata.lead_id ?? null;
  if (!clientId || !leadId) {
    return NextResponse.json({ ok: true, ignored: "missing metadata lead/client" });
  }

  const supabase = createServiceClient();

  // Verify HMAC signature when the client has a per-client webhook_secret.
  const { data: clientRow } = await supabase
    .from("clients")
    .select("calendar_config")
    .eq("id", clientId)
    .maybeSingle();
  const secret =
    (clientRow as { calendar_config?: { webhook_secret?: string } | null } | null)?.calendar_config
      ?.webhook_secret ?? null;
  if (secret) {
    const signature = req.headers.get("x-cal-signature-256");
    if (!signature) {
      return new NextResponse("Missing signature", { status: 401 });
    }
    const expected = createHmac("sha256", secret).update(raw).digest("hex");
    try {
      if (
        signature.length !== expected.length ||
        !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))
      ) {
        return new NextResponse("Bad signature", { status: 401 });
      }
    } catch {
      return new NextResponse("Bad signature", { status: 401 });
    }
  } else {
    console.warn(
      `[cal-com webhook] client ${clientId} has no calendar_config.webhook_secret — skipping signature check (dev only)`,
    );
  }

  // Upsert the meetings row by cal_booking_id for idempotency.
  if (booking.kind === "BOOKING_CANCELLED") {
    await supabase
      .from("meetings")
      .update({ status: "cancelled" })
      .eq("cal_booking_id", booking.cal_booking_id);
    await logEvent({
      service: true,
      event_type: "meeting_no_show",
      lead_id: leadId,
      client_id: clientId,
      payload: { kind: "booking_cancelled", cal_booking_id: booking.cal_booking_id },
    });
    return NextResponse.json({ ok: true, applied: "cancelled" });
  }

  const upsertRow: Partial<Meeting> & { cal_booking_id: string } = {
    client_id: clientId,
    lead_id: leadId,
    scheduled_at: booking.scheduled_at,
    duration_minutes: booking.duration_minutes ?? 30,
    format: "video",
    status: "scheduled",
    cal_booking_id: booking.cal_booking_id,
    cal_booking_url: booking.cal_booking_url,
  };

  const { error: upsertErr } = await supabase
    .from("meetings")
    .upsert(upsertRow as never, { onConflict: "cal_booking_id" });
  if (upsertErr) {
    console.error("[cal-com webhook] meeting upsert failed", upsertErr);
    return NextResponse.json({ ok: false, error: upsertErr.message }, { status: 500 });
  }

  // Advance the lead to have_meeting via the stage engine — handles
  // human-task creation + outreach pause for us.
  if (booking.kind === "BOOKING_CREATED") {
    const r = await transitionLeadToStage(supabase, leadId, HAVE_MEETING_STAGE_ID, {
      service: true,
    });
    if (!r.ok) {
      console.warn(`[cal-com webhook] stage transition failed: ${r.error}`);
    }
  }

  await logEvent({
    service: true,
    event_type: "meeting_booked",
    lead_id: leadId,
    client_id: clientId,
    payload: {
      kind: booking.kind.toLowerCase(),
      cal_booking_id: booking.cal_booking_id,
      scheduled_at: booking.scheduled_at,
    },
  });

  return NextResponse.json({ ok: true, applied: booking.kind });
}
