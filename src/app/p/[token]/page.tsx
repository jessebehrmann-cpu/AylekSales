import { notFound } from "next/navigation";
import { createServiceClient } from "@/lib/supabase/server";
import type { Proposal } from "@/lib/supabase/types";
import { ProposalView } from "./proposal-view";

export const dynamic = "force-dynamic";

/**
 * Item 8 — public proposal page. Gated by the per-proposal token (uuid
 * default in the schema). No auth — Close-01 emails the link directly
 * to the lead. First view increments view_count + flips status to
 * 'viewed' (handled inside the server component so it works without
 * JS).
 */
export default async function ProposalPage({
  params,
}: {
  params: { token: string };
}) {
  const supabase = createServiceClient();
  const { data: row } = await supabase
    .from("proposals")
    .select("*")
    .eq("token", params.token)
    .maybeSingle();
  const proposal = row as Proposal | null;
  if (!proposal) notFound();

  // First-view side-effect: idempotent — once `viewed_at` is set we
  // don't overwrite it (so we keep the original first-view timestamp).
  if (proposal.status === "sent" || !proposal.viewed_at) {
    await supabase
      .from("proposals")
      .update({
        status: proposal.status === "sent" ? "viewed" : proposal.status,
        viewed_at: proposal.viewed_at ?? new Date().toISOString(),
        view_count: (proposal.view_count ?? 0) + 1,
      })
      .eq("id", proposal.id);
  } else {
    await supabase
      .from("proposals")
      .update({ view_count: (proposal.view_count ?? 0) + 1 })
      .eq("id", proposal.id);
  }

  return (
    <ProposalView
      token={proposal.token}
      subject={proposal.subject}
      html={proposal.html_content}
      amountCents={proposal.amount_cents}
      currency={proposal.currency ?? "usd"}
      status={proposal.status === "sent" ? "viewed" : proposal.status}
      paymentLinkUrl={proposal.stripe_payment_link_url}
    />
  );
}
