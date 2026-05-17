import { NextResponse, type NextRequest } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { logEvent } from "@/lib/events";
import { stripe } from "@/lib/stripe";
import type { DealColdPayload, Proposal } from "@/lib/supabase/types";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * Item 8 — lead accepts a Close-01 proposal.
 *
 * Two paths:
 *  1. amount_cents IS set → create a Stripe Payment Link via
 *     `stripe.paymentLinks.create`, persist the link URL on the proposal,
 *     flip status='accepted', and return the URL so the client redirects.
 *  2. amount_cents IS null → flip status='accepted', open a `deal_cold`-
 *     style approval (reason='manual') so HOS knows to follow up. No
 *     Stripe call.
 *
 * Idempotent: re-accepting an already-accepted proposal returns the same
 * payment link; re-accepting a paid one is a no-op with the same shape.
 */
export async function POST(
  _req: NextRequest,
  { params }: { params: { token: string } },
): Promise<NextResponse> {
  const supabase = createServiceClient();

  const { data: row } = await supabase
    .from("proposals")
    .select("*")
    .eq("token", params.token)
    .maybeSingle();
  const proposal = row as Proposal | null;
  if (!proposal) {
    return NextResponse.json({ ok: false, error: "Proposal not found" }, { status: 404 });
  }
  if (proposal.status === "paid") {
    return NextResponse.json({
      ok: true,
      mode: proposal.amount_cents != null ? "stripe" : "manual",
      payment_link_url: proposal.stripe_payment_link_url,
    });
  }

  // ── Manual path ──────────────────────────────────────────────────────
  if (proposal.amount_cents == null) {
    if (proposal.status !== "accepted") {
      await supabase
        .from("proposals")
        .update({ status: "accepted", accepted_at: new Date().toISOString() })
        .eq("id", proposal.id);

      // Open a `deal_cold` approval with reason='manual' so HOS follows
      // up (no Stripe path = no auto-checkout).
      const payload: DealColdPayload = {
        proposal_id: proposal.id,
        lead_id: proposal.lead_id,
        reason: "manual",
        lead_name: "(see lead)",
        proposal_subject: proposal.subject,
        proposal_url: `${proposalBaseUrl()}/p/${proposal.token}`,
        amount_cents: null,
        staleness_hours: 0,
      };
      // best-effort enrich with lead name
      const { data: leadRow } = await supabase
        .from("leads")
        .select("company_name, client_id")
        .eq("id", proposal.lead_id)
        .maybeSingle();
      if (leadRow) {
        payload.lead_name = (leadRow as { company_name: string }).company_name;
      }
      const clientId =
        (leadRow as { client_id: string | null } | null)?.client_id ?? proposal.client_id;
      if (clientId) {
        await supabase.from("approvals").insert({
          client_id: clientId,
          type: "deal_cold",
          status: "pending",
          title: `${payload.lead_name}: accepted proposal — pricing TBD`,
          summary:
            "Lead accepted but no Stripe payment link could be generated (no pricing on file). Follow up to finalise the contract + invoice.",
          payload: payload as unknown as Record<string, unknown>,
        });
      }

      await logEvent({
        service: true,
        event_type: "ai_action",
        client_id: clientId,
        lead_id: proposal.lead_id,
        payload: {
          kind: "close01_proposal_accepted_manual",
          proposal_id: proposal.id,
          lead_name: payload.lead_name,
        },
      });
    }
    return NextResponse.json({ ok: true, mode: "manual", payment_link_url: null });
  }

  // ── Stripe path ──────────────────────────────────────────────────────
  if (proposal.stripe_payment_link_url) {
    // Already accepted once; return the cached link.
    return NextResponse.json({
      ok: true,
      mode: "stripe",
      payment_link_url: proposal.stripe_payment_link_url,
    });
  }

  if (!process.env.STRIPE_SECRET_KEY) {
    return NextResponse.json(
      { ok: false, error: "Stripe is not configured on this environment." },
      { status: 500 },
    );
  }

  const productName = proposal.subject.slice(0, 90) || "Aylek proposal";
  let paymentLink: Awaited<ReturnType<typeof stripe.paymentLinks.create>>;
  try {
    // Stripe Payment Links require a Price object — there's no inline
    // price_data shorthand here (unlike checkout.sessions). Create the
    // price + ad-hoc product inline, then build the payment link.
    const price = await stripe.prices.create({
      currency: proposal.currency ?? "usd",
      unit_amount: proposal.amount_cents,
      product_data: { name: productName },
    });
    paymentLink = await stripe.paymentLinks.create({
      line_items: [{ price: price.id, quantity: 1 }],
      metadata: {
        proposal_id: proposal.id,
        lead_id: proposal.lead_id,
        client_id: proposal.client_id ?? "",
      },
      after_completion: {
        type: "redirect",
        redirect: { url: `${proposalBaseUrl()}/p/${proposal.token}` },
      },
    });
  } catch (err) {
    return NextResponse.json(
      {
        ok: false,
        error: `Stripe payment link create failed: ${err instanceof Error ? err.message : String(err)}`,
      },
      { status: 502 },
    );
  }

  await supabase
    .from("proposals")
    .update({
      status: "accepted",
      accepted_at: new Date().toISOString(),
      stripe_payment_link_id: paymentLink.id,
      stripe_payment_link_url: paymentLink.url,
    })
    .eq("id", proposal.id);

  await logEvent({
    service: true,
    event_type: "ai_action",
    client_id: proposal.client_id,
    lead_id: proposal.lead_id,
    payload: {
      kind: "close01_proposal_accepted_stripe",
      proposal_id: proposal.id,
      payment_link_id: paymentLink.id,
      amount_cents: proposal.amount_cents,
    },
  });

  return NextResponse.json({ ok: true, mode: "stripe", payment_link_url: paymentLink.url });
}

function proposalBaseUrl(): string {
  return (
    process.env.PROPOSAL_BASE_URL ??
    process.env.NEXT_PUBLIC_APP_URL ??
    (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : "http://localhost:3000")
  );
}
