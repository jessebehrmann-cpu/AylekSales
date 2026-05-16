/**
 * Weekly per-client digest builder.
 *
 * Pulls metrics for the last 7 days for one client, then asks Claude to
 * write a short executive summary in the client's voice (from the
 * playbook's voice_tone). Falls back to a deterministic summary when
 * Claude is unavailable.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  anthropic,
  ANTHROPIC_MODEL,
  isAnthropicKeyMissing,
  isAnthropicUnavailableError,
} from "@/lib/anthropic";
import type { Client, Database, Playbook } from "@/lib/supabase/types";

type Supa = SupabaseClient<Database>;

export type WeeklyMetrics = {
  client: Pick<Client, "id" | "name" | "owner_name">;
  window: { from: string; to: string };
  leads_sourced: number;
  emails_sent: number;
  replies_received: number;
  meetings_booked: number;
  proposals_sent: number;
  deals_won: number;
  revenue_won_cents: number;
};

export async function collectWeeklyMetrics(
  supabase: Supa,
  clientId: string,
): Promise<WeeklyMetrics | null> {
  const now = new Date();
  const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

  const { data: clientRow } = await supabase
    .from("clients")
    .select("id, name, owner_name")
    .eq("id", clientId)
    .maybeSingle();
  const client = clientRow as Pick<Client, "id" | "name" | "owner_name"> | null;
  if (!client) return null;

  const since = weekAgo.toISOString();
  const [
    { count: leadsSourced },
    { count: emailsSent },
    { count: repliesReceived },
    { count: meetingsBooked },
    { count: proposalsSent },
    { data: wonRows },
  ] = await Promise.all([
    supabase.from("leads").select("id", { count: "exact", head: true }).eq("client_id", clientId).gte("created_at", since),
    supabase.from("emails").select("id", { count: "exact", head: true }).eq("client_id", clientId).eq("direction", "outbound").gte("sent_at", since),
    supabase.from("emails").select("id", { count: "exact", head: true }).eq("client_id", clientId).eq("direction", "inbound").gte("replied_at", since),
    supabase.from("meetings").select("id", { count: "exact", head: true }).eq("client_id", clientId).gte("created_at", since),
    supabase.from("emails").select("id", { count: "exact", head: true }).eq("client_id", clientId).eq("direction", "outbound").gte("sent_at", since).ilike("subject", "%proposal%"),
    supabase.from("quotes").select("amount").eq("client_id", clientId).eq("status", "accepted").gte("responded_at", since),
  ]);

  const revenue = ((wonRows ?? []) as Array<{ amount: number | null }>).reduce(
    (sum, r) => sum + (r.amount ?? 0),
    0,
  );

  return {
    client,
    window: { from: since, to: now.toISOString() },
    leads_sourced: leadsSourced ?? 0,
    emails_sent: emailsSent ?? 0,
    replies_received: repliesReceived ?? 0,
    meetings_booked: meetingsBooked ?? 0,
    proposals_sent: proposalsSent ?? 0,
    deals_won: ((wonRows ?? []) as unknown[]).length,
    revenue_won_cents: Math.round(revenue * 100),
  };
}

/**
 * Write the digest email body. 4 bullets max. Anchored on the metrics.
 * Falls back to a deterministic summary when Claude is unavailable.
 */
export async function draftDigestBody(args: {
  metrics: WeeklyMetrics;
  playbook: Playbook | null;
}): Promise<{ subject: string; body: string; warning?: string }> {
  const { metrics, playbook } = args;
  const ownerFirst = (metrics.client.owner_name ?? "").split(" ")[0] || "there";
  const subject = `${metrics.client.name} — last week`;

  if (isAnthropicKeyMissing()) {
    return { subject, body: deterministicBody(metrics, ownerFirst), warning: "Anthropic key missing" };
  }

  const voice = playbook?.voice_tone ?? {};
  const system = `You write short, plain-English weekly executive digests for sales operators. Use the supplied voice & tone. No corporate fluff. No "I hope this finds you well". 4 short bullets max + a one-sentence opening. End with one specific suggestion for what to focus on next week.`;
  const prompt = `Client: ${metrics.client.name}
Window: last 7 days

Metrics:
- Leads sourced: ${metrics.leads_sourced}
- Emails sent: ${metrics.emails_sent}
- Replies received: ${metrics.replies_received}
- Meetings booked: ${metrics.meetings_booked}
- Proposals sent: ${metrics.proposals_sent}
- Deals won: ${metrics.deals_won}
- Revenue won: $${(metrics.revenue_won_cents / 100).toFixed(0)}

Voice & tone:
${JSON.stringify(voice, null, 2)}

Owner first name: ${ownerFirst}

Write the body. Begin with "Hi ${ownerFirst}," then a 1-sentence opener, 4 short bullets of last week's progress, then 1 line of what to focus on next week. Sign off "Aylek".`;

  try {
    const res = await anthropic.messages.create({
      model: ANTHROPIC_MODEL,
      max_tokens: 1200,
      system,
      messages: [{ role: "user", content: prompt }],
      aylekClientId: metrics.client.id,
    });
    const text = res.content[0]?.type === "text" ? res.content[0].text : "";
    if (!text.trim()) {
      return { subject, body: deterministicBody(metrics, ownerFirst), warning: "Claude returned empty" };
    }
    return { subject, body: text };
  } catch (err) {
    return {
      subject,
      body: deterministicBody(metrics, ownerFirst),
      warning: isAnthropicUnavailableError(err)
        ? "Anthropic unavailable"
        : err instanceof Error
          ? err.message
          : String(err),
    };
  }
}

function deterministicBody(m: WeeklyMetrics, ownerFirst: string): string {
  return `Hi ${ownerFirst},

Last week for ${m.client.name}:

- ${m.leads_sourced} new leads sourced
- ${m.emails_sent} emails sent, ${m.replies_received} replies received
- ${m.meetings_booked} meetings booked, ${m.proposals_sent} proposals sent
- ${m.deals_won} deals won${m.revenue_won_cents > 0 ? ` ($${(m.revenue_won_cents / 100).toFixed(0)} in revenue)` : ""}

Reply to this email if anything needs tweaking.

Aylek`;
}
