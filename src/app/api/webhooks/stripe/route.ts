import { NextResponse, type NextRequest } from "next/server";

/**
 * Stripe webhook handler.
 *  - invoice.payment_succeeded → client.status = 'active'
 *  - invoice.payment_failed    → client.status = 'paused'
 *  - customer.subscription.deleted → client.status = 'churned'
 *
 * Signature verification uses STRIPE_WEBHOOK_SECRET. Implementation lands in the next pass.
 */
export async function POST(req: NextRequest) {
  const text = await req.text();
  console.log("[stripe webhook] received", text.length, "bytes");
  return NextResponse.json({ ok: true });
}
