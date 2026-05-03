import { NextResponse, type NextRequest } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { verifySvixSignature } from "@/lib/webhooks";
import { logEvent } from "@/lib/events";
import { processInboundEmail, type InboundEmail } from "@/lib/inbound";

export const dynamic = "force-dynamic";

/**
 * Resend webhook handler.
 *
 * Outbound delivery events update the matching `emails` row by `resend_message_id`.
 * Reply events flow through `processInboundEmail` for AI qualification + auto-reply.
 *
 * Configure at https://resend.com/webhooks pointing here, with secret in
 * RESEND_WEBHOOK_SECRET (whsec_...). Subscribe to email.delivered, email.opened,
 * email.bounced, email.complained, and (for inbound) the inbound forward.
 */
export async function POST(req: NextRequest) {
  const raw = await req.text();
  const secret = process.env.RESEND_WEBHOOK_SECRET;
  if (secret) {
    const ok = verifySvixSignature(raw, req.headers, secret);
    if (!ok) return new NextResponse("Bad signature", { status: 401 });
  }
  // If secret not set, accept (dev mode) — but log loudly.
  if (!secret) console.warn("[resend webhook] RESEND_WEBHOOK_SECRET unset — skipping signature check");

  let body: WebhookEvent;
  try {
    body = JSON.parse(raw) as WebhookEvent;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const supabase = createServiceClient();
  const type = body.type;
  const data = body.data ?? {};

  // ── Inbound (treat any "inbound" or "received" event as a reply) ──────────
  if (type?.includes("inbound") || type?.includes("received")) {
    const inbound = normaliseInbound(data);
    if (inbound) {
      await processInboundEmail(inbound);
    }
    return NextResponse.json({ ok: true });
  }

  // ── Outbound delivery events ──────────────────────────────────────────────
  const messageId = (data as Record<string, unknown>).email_id ?? data.id ?? null;
  if (!messageId || typeof messageId !== "string") {
    return NextResponse.json({ ok: true, ignored: "no email_id" });
  }

  const { data: emailRow } = await supabase
    .from("emails")
    .select("id, lead_id, client_id, campaign_id, subject")
    .eq("resend_message_id", messageId)
    .maybeSingle();

  if (!emailRow) {
    return NextResponse.json({ ok: true, ignored: "no matching email row" });
  }

  const now = new Date().toISOString();

  switch (type) {
    case "email.delivered":
    case "email.sent":
      await supabase
        .from("emails")
        .update({ status: "sent", sent_at: emailRow_safe(emailRow).sent_at ?? now })
        .eq("id", emailRow.id);
      break;

    case "email.opened":
      await supabase.from("emails").update({ status: "opened", opened_at: now }).eq("id", emailRow.id);
      await logEvent({
        service: true,
        event_type: "email_opened",
        lead_id: emailRow.lead_id,
        client_id: emailRow.client_id,
        campaign_id: emailRow.campaign_id,
        payload: { resend_message_id: messageId, subject: emailRow.subject },
      });
      break;

    case "email.bounced":
    case "email.complained":
      await supabase.from("emails").update({ status: "bounced" }).eq("id", emailRow.id);
      // Auto-unsubscribe lead on hard bounce / complaint
      if (emailRow.lead_id) {
        await supabase.from("leads").update({ stage: "unsubscribed" }).eq("id", emailRow.lead_id);
      }
      await logEvent({
        service: true,
        event_type: "email_bounced",
        lead_id: emailRow.lead_id,
        client_id: emailRow.client_id,
        campaign_id: emailRow.campaign_id,
        payload: { resend_message_id: messageId, kind: type },
      });
      break;

    default:
      // ignore
      break;
  }

  return NextResponse.json({ ok: true });
}

type WebhookEvent = {
  type?: string;
  created_at?: string;
  data?: { id?: string; email_id?: string; [k: string]: unknown };
};

function emailRow_safe(row: Record<string, unknown>) {
  return row as { id: string; sent_at?: string };
}

function normaliseInbound(data: Record<string, unknown>): InboundEmail | null {
  // Resend's inbound shape varies; also handle Postmark/SendGrid-like forwards
  // for tolerance.
  const fromField = (data.from ?? data.From ?? data.from_email) as
    | string
    | { email?: string; name?: string }
    | undefined;
  let from_email = "";
  let from_name: string | undefined;
  if (typeof fromField === "string") {
    const m = fromField.match(/^(?:"?([^"]*)"?\s*)?<?([^<>\s]+@[^<>\s]+)>?$/);
    if (m) {
      from_name = m[1]?.trim() || undefined;
      from_email = m[2];
    } else {
      from_email = fromField;
    }
  } else if (fromField && typeof fromField === "object") {
    from_email = fromField.email ?? "";
    from_name = fromField.name;
  }
  if (!from_email) return null;

  return {
    from_email,
    from_name,
    to_email: typeof data.to === "string" ? data.to : undefined,
    subject: (data.subject as string | undefined) ?? undefined,
    text: (data.text as string | undefined) ?? (data.plain as string | undefined) ?? undefined,
    html: (data.html as string | undefined) ?? undefined,
    message_id: (data.id as string | undefined) ?? (data.message_id as string | undefined) ?? undefined,
  };
}
