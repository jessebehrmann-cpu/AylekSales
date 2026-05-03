import { NextResponse, type NextRequest } from "next/server";
import { stripe } from "@/lib/stripe";
import { createServiceClient } from "@/lib/supabase/server";
import { logEvent } from "@/lib/events";
import type Stripe from "stripe";

export const dynamic = "force-dynamic";

/**
 * Stripe webhook handler.
 *
 *  - invoice.payment_succeeded → client.status = 'active'
 *  - invoice.payment_failed    → client.status = 'paused'
 *  - customer.subscription.deleted → client.status = 'churned'
 *
 * Configure at https://dashboard.stripe.com/test/webhooks pointing here, with
 * STRIPE_WEBHOOK_SECRET set to the signing secret.
 */
export async function POST(req: NextRequest) {
  const raw = await req.text();
  const signature = req.headers.get("stripe-signature");
  const secret = process.env.STRIPE_WEBHOOK_SECRET;

  if (!secret || !signature) {
    if (!secret) console.warn("[stripe webhook] STRIPE_WEBHOOK_SECRET unset");
    if (!signature) return new NextResponse("Missing stripe-signature", { status: 400 });
  }

  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(raw, signature!, secret!);
  } catch (err) {
    return new NextResponse(`Bad signature: ${err instanceof Error ? err.message : "unknown"}`, {
      status: 400,
    });
  }

  const supabase = createServiceClient();

  switch (event.type) {
    case "invoice.payment_succeeded": {
      const invoice = event.data.object as Stripe.Invoice;
      const customerId = typeof invoice.customer === "string" ? invoice.customer : invoice.customer?.id;
      if (customerId) {
        const { data: client } = await supabase
          .from("clients")
          .select("id, name")
          .eq("stripe_customer_id", customerId)
          .maybeSingle();
        if (client) {
          await supabase.from("clients").update({ status: "active" }).eq("id", client.id);
          await logEvent({
            service: true,
            event_type: "ai_action",
            client_id: client.id,
            payload: {
              kind: "stripe_payment_succeeded",
              client_name: client.name,
              amount_cents: invoice.amount_paid,
              currency: invoice.currency,
              invoice_id: invoice.id,
            },
          });
        }
      }
      break;
    }
    case "invoice.payment_failed": {
      const invoice = event.data.object as Stripe.Invoice;
      const customerId = typeof invoice.customer === "string" ? invoice.customer : invoice.customer?.id;
      if (customerId) {
        const { data: client } = await supabase
          .from("clients")
          .select("id, name")
          .eq("stripe_customer_id", customerId)
          .maybeSingle();
        if (client) {
          await supabase.from("clients").update({ status: "paused" }).eq("id", client.id);
          await logEvent({
            service: true,
            event_type: "ai_action",
            client_id: client.id,
            payload: {
              kind: "stripe_payment_failed",
              client_name: client.name,
              invoice_id: invoice.id,
            },
          });
        }
      }
      break;
    }
    case "customer.subscription.deleted": {
      const sub = event.data.object as Stripe.Subscription;
      const customerId = typeof sub.customer === "string" ? sub.customer : sub.customer.id;
      if (customerId) {
        const { data: client } = await supabase
          .from("clients")
          .select("id, name")
          .eq("stripe_customer_id", customerId)
          .maybeSingle();
        if (client) {
          await supabase.from("clients").update({ status: "churned" }).eq("id", client.id);
          await logEvent({
            service: true,
            event_type: "ai_action",
            client_id: client.id,
            payload: { kind: "stripe_subscription_cancelled", client_name: client.name },
          });
        }
      }
      break;
    }
  }

  return NextResponse.json({ received: true });
}
