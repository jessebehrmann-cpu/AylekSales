import { NextResponse, type NextRequest } from "next/server";
import { stripe } from "@/lib/stripe";
import { createServiceClient } from "@/lib/supabase/server";
import { logEvent } from "@/lib/events";
import { spawnOnboardingSession } from "@/lib/onboarding-trigger";
import { transitionLeadToStage, SEND_PROPOSAL_STAGE_ID } from "@/lib/stage-engine";
import type { Lead, Proposal } from "@/lib/supabase/types";
import type Stripe from "stripe";

export const dynamic = "force-dynamic";

/**
 * Stripe webhook handler.
 *
 *  - invoice.payment_succeeded → client.status = 'active'
 *  - invoice.payment_failed    → client.status = 'paused'
 *  - customer.subscription.deleted → client.status = 'churned'
 *  - checkout.session.completed (Item 8) → mark proposal paid, advance
 *      the lead, and spawn an onboarding session.
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
    case "checkout.session.completed": {
      // Item 8 — Close-01 payment lands. The Payment Link was created
      // with metadata={proposal_id, lead_id, client_id} so we can find
      // the right proposal directly without scanning by link id. Fall
      // back to a link-id lookup for older proposals.
      const session = event.data.object as Stripe.Checkout.Session;
      const metaProposalId = session.metadata?.proposal_id;
      const linkId = typeof session.payment_link === "string" ? session.payment_link : null;

      let proposal: Proposal | null = null;
      if (metaProposalId) {
        const { data } = await supabase
          .from("proposals")
          .select("*")
          .eq("id", metaProposalId)
          .maybeSingle();
        proposal = data as Proposal | null;
      }
      if (!proposal && linkId) {
        const { data } = await supabase
          .from("proposals")
          .select("*")
          .eq("stripe_payment_link_id", linkId)
          .maybeSingle();
        proposal = data as Proposal | null;
      }
      if (!proposal) {
        console.warn(`[stripe webhook] checkout.session.completed — no proposal match (metaId=${metaProposalId ?? "n/a"}, linkId=${linkId ?? "n/a"})`);
        break;
      }
      // Idempotent: if we've already marked it paid, do nothing more.
      if (proposal.status === "paid") break;

      await supabase
        .from("proposals")
        .update({ status: "paid", paid_at: new Date().toISOString() })
        .eq("id", proposal.id);

      // Resolve the lead so we can drive the post-payment side effects.
      const { data: leadRow } = await supabase
        .from("leads")
        .select("id, client_id, company_name, contact_name, email")
        .eq("id", proposal.lead_id)
        .maybeSingle();
      const lead = leadRow as Pick<Lead, "id" | "client_id" | "company_name" | "contact_name" | "email"> | null;

      // Advance the lead's stage to send_proposal → onboard (the engine
      // handles destination-side effects). Best-effort: a failed
      // transition logs but doesn't fail the webhook.
      if (lead?.id) {
        try {
          await transitionLeadToStage(supabase, lead.id, SEND_PROPOSAL_STAGE_ID, {
            userId: null,
          });
        } catch (err) {
          console.warn(`[stripe webhook] stage transition failed for lead ${lead.id}:`, err);
        }
      }

      // Trigger onboarding for the (now paying) client. Idempotent
      // inside spawnOnboardingSession — re-runs reuse the existing session.
      if (lead?.client_id && lead.email) {
        try {
          await spawnOnboardingSession(supabase, {
            clientId: lead.client_id,
            leadId: lead.id,
            contactEmail: lead.email,
            contactName: lead.contact_name,
            clientName: lead.company_name,
          });
        } catch (err) {
          console.warn(`[stripe webhook] spawnOnboardingSession failed for lead ${lead.id}:`, err);
        }
      }

      await logEvent({
        service: true,
        event_type: "ai_action",
        client_id: lead?.client_id ?? proposal.client_id,
        lead_id: proposal.lead_id,
        payload: {
          kind: "close01_proposal_paid",
          proposal_id: proposal.id,
          lead_name: lead?.company_name ?? null,
          amount_cents: proposal.amount_cents,
          stripe_session_id: session.id,
        },
      });
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
