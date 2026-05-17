"use client";

import { useState, useTransition } from "react";
import type { ProposalStatus } from "@/lib/supabase/types";

export function ProposalView({
  token,
  subject,
  html,
  amountCents,
  currency,
  status,
  paymentLinkUrl,
}: {
  token: string;
  subject: string;
  html: string;
  amountCents: number | null;
  currency: string;
  status: ProposalStatus;
  paymentLinkUrl: string | null;
}) {
  const [error, setError] = useState<string | null>(null);
  const [accepted, setAccepted] = useState(status === "accepted" || status === "paid");
  const [redirecting, start] = useTransition();
  const [followupSent, setFollowupSent] = useState(false);

  function accept() {
    setError(null);
    start(async () => {
      try {
        const res = await fetch(`/api/proposals/${token}/accept`, { method: "POST" });
        const json = (await res.json().catch(() => null)) as
          | {
              ok: boolean;
              error?: string;
              payment_link_url?: string | null;
              mode?: "stripe" | "manual";
            }
          | null;
        if (!json?.ok) {
          setError(json?.error ?? "Couldn't accept. Please try again.");
          return;
        }
        setAccepted(true);
        if (json.mode === "stripe" && json.payment_link_url) {
          window.location.href = json.payment_link_url;
        } else {
          setFollowupSent(true);
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    });
  }

  const hasStripe = amountCents != null;
  const priceLabel = hasStripe
    ? new Intl.NumberFormat(undefined, {
        style: "currency",
        currency: (currency || "usd").toUpperCase(),
      }).format((amountCents ?? 0) / 100)
    : null;

  return (
    <main className="min-h-screen bg-[#fafafa] text-[#1d1d1f]">
      <div className="mx-auto max-w-3xl px-6 py-12 sm:py-20">
        <div className="mb-8">
          <p className="text-xs uppercase tracking-[0.18em] text-[#6e6e73]">Proposal</p>
          <h1 className="mt-1 text-3xl font-semibold tracking-tight sm:text-4xl">{subject}</h1>
        </div>

        <article
          className="prose prose-neutral max-w-none rounded-2xl border border-[#e5e5ea] bg-white p-8 shadow-sm"
          dangerouslySetInnerHTML={{ __html: html }}
        />

        {(status === "paid" || status === "accepted") && !redirecting && (
          <div className="mt-8 rounded-2xl border border-emerald-300 bg-emerald-50 p-5 text-sm text-emerald-900">
            {status === "paid"
              ? "Payment received — we'll be in touch with onboarding details shortly."
              : hasStripe && paymentLinkUrl
                ? "Accepted. Follow the payment link we just emailed you to complete checkout."
                : "Accepted. Someone from the team will reply within one business day."}
          </div>
        )}

        {!accepted && status !== "paid" && status !== "accepted" && (
          <div className="mt-8 flex flex-wrap items-center justify-between gap-4 rounded-2xl border border-[#e5e5ea] bg-white p-5 shadow-sm">
            <div>
              {hasStripe ? (
                <p className="text-sm text-[#6e6e73]">
                  Accepting this will send you to a secure Stripe checkout for{" "}
                  <strong className="text-[#1d1d1f]">{priceLabel}</strong>.
                </p>
              ) : (
                <p className="text-sm text-[#6e6e73]">
                  Pricing is bespoke — accepting will let the team know to follow up
                  with you directly.
                </p>
              )}
              {error && <p className="mt-2 text-sm text-red-600">{error}</p>}
            </div>
            <button
              onClick={accept}
              disabled={redirecting}
              className="rounded-full bg-[#1d1d1f] px-6 py-3 text-sm font-semibold text-white transition hover:bg-black disabled:opacity-60"
            >
              {redirecting ? "Working…" : hasStripe ? "Accept & pay" : "Reply to discuss"}
            </button>
          </div>
        )}

        {followupSent && (
          <p className="mt-6 text-center text-xs text-[#6e6e73]">
            We&apos;ve been notified — expect a reply within a business day.
          </p>
        )}

        <p className="mt-12 text-center text-[11px] uppercase tracking-[0.18em] text-[#a1a1a6]">
          Aylek · token: {token.slice(0, 8)}…
        </p>
      </div>
    </main>
  );
}
