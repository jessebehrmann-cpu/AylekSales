import { NextResponse, type NextRequest } from "next/server";

/**
 * Resend webhook handler.
 *
 * Wires up:
 *  - email.opened    → mark email opened, log event
 *  - email.bounced   → mark bounced, log event
 *  - email.delivered → mark sent (best-effort)
 *  - inbound         → create/match lead, store inbound email, run AI qualification, auto-reply
 *
 * Signature verification uses RESEND_WEBHOOK_SECRET via the Svix-style headers Resend sends.
 * Implementation lands in the next pass.
 */
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  console.log("[resend webhook] received", body?.type ?? "(no type)");
  return NextResponse.json({ ok: true });
}
