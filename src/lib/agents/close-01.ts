/**
 * Close-01 — drafts polished HTML proposals after a successful meeting,
 * emails the lead a /p/[token] link, and follows up via the daily cron
 * until the deal closes or goes cold.
 *
 * End-to-end flow:
 *   1. submitMeetingNotes (leads/actions.ts) calls draftProposalHtml
 *      with the meeting note + playbook context.
 *   2. We create a proposals row (status='sent'), then sendProposal
 *      emails the lead a link to /p/[token]. amount_cents is read from
 *      playbook.pricing_cents — when null/undefined the proposal goes
 *      out WITHOUT a Stripe payment link and the public page shows a
 *      "Reply to discuss" CTA instead.
 *   3. Lead opens /p/[token] → view_count increments + status flips to
 *      'viewed' on the first open.
 *   4. Lead clicks Accept → /api/proposals/[token]/accept generates a
 *      Stripe Payment Link (when amount_cents is set) and emails it.
 *   5. Stripe webhook (checkout.session.completed) flips status to
 *      'paid' and triggers onboarding.
 *   6. Cron (/api/cron/close-01) runs every 4h: triggerFollowup +
 *      flagCold sweep across sent/viewed proposals.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  anthropic,
  ANTHROPIC_KEY_MISSING_MESSAGE,
  ANTHROPIC_MODEL,
  isAnthropicKeyMissing,
  isAnthropicUnavailableError,
  parseJsonResponse,
} from "@/lib/anthropic";
import { resend, FROM_EMAIL } from "@/lib/resend";
import { getClientSendingConfig } from "@/lib/email-config";
import { isActivelySuppressed } from "@/lib/suppression";
import { logEvent } from "@/lib/events";
import type {
  Database,
  DealColdPayload,
  Lead,
  MeetingNote,
  Playbook,
  Proposal,
} from "@/lib/supabase/types";

type Supa = SupabaseClient<Database>;

// ─────────────────────────────────────────────────────────────────────────
// Draft — Claude generates the HTML proposal anchored on meeting context
// ─────────────────────────────────────────────────────────────────────────

export type ProposalDraftInput = {
  playbook: Playbook | null;
  lead: Pick<Lead, "company_name" | "contact_name" | "title" | "industry">;
  meetingNote: Pick<MeetingNote, "outcome" | "notes" | "transcript" | "objections" | "next_steps"> | null;
};

export type DraftedProposal = {
  subject: string;
  html: string;
  /**
   * Pricing: defaults to `playbook.pricing_cents` when present, else
   * `null`. Never hardcoded — per the master brief refinement, if a
   * client has no pricing on file the proposal goes out without a
   * payment link and HOS follows up manually.
   */
  amount_cents: number | null;
  warning?: string;
};

export async function draftProposalHtml(args: ProposalDraftInput): Promise<DraftedProposal> {
  const { playbook, lead, meetingNote } = args;
  const amount_cents =
    typeof playbook?.pricing_cents === "number" && Number.isFinite(playbook.pricing_cents)
      ? playbook.pricing_cents
      : null;

  if (isAnthropicKeyMissing()) {
    return {
      subject: fallbackSubject(lead.company_name),
      html: fallbackHtml(lead, meetingNote),
      amount_cents,
      warning: ANTHROPIC_KEY_MISSING_MESSAGE,
    };
  }

  const strategy = playbook?.strategy ?? {};
  const voice = playbook?.voice_tone ?? {};
  const system = `You are a senior B2B sales copywriter writing a polished HTML proposal anchored on the discovery-call notes and the client's playbook. Output ONE web-ready proposal page in clean semantic HTML (no <html>/<head>/<body> — just the inner content). Use sections with <h2> headings: "What we heard", "What we're proposing", "Pricing & terms" (only when amount_cents is set), "Next step". Reference specific phrases from the meeting notes. Voice + tone come from the playbook. Max 600 words. No marketing fluff, no "synergy", no "leverage".`;

  const lines = [
    `Lead: ${lead.contact_name ?? ""} (${lead.title ?? ""}) at ${lead.company_name}`,
    `Industry: ${lead.industry ?? "(unspecified)"}`,
    `Meeting outcome: ${meetingNote?.outcome ?? "n/a"}`,
    `Meeting notes:\n${meetingNote?.notes ?? "(none)"}`,
    `Key objections: ${meetingNote?.objections ?? "(none)"}`,
    `Agreed next steps: ${meetingNote?.next_steps ?? "(none)"}`,
    `Pricing on file (cents, null = no pricing — DO NOT include the "Pricing & terms" section): ${amount_cents ?? "null"}`,
    `STRATEGY: ${JSON.stringify(strategy)}`,
    `VOICE & TONE: ${JSON.stringify(voice)}`,
  ].join("\n\n");

  const prompt = `${lines}

Return ONLY valid JSON, no markdown:
{
  "subject": "<= 80 chars, specific to ${lead.company_name}, no 'Proposal for'",
  "html": "<polished HTML proposal — <h2> sections, <p>, <ul>, no <html>/<body>>"
}`;

  try {
    const response = await anthropic.messages.create({
      model: ANTHROPIC_MODEL,
      max_tokens: 3500,
      system,
      messages: [{ role: "user", content: prompt }],
    });
    const text = response.content[0]?.type === "text" ? response.content[0].text : "";
    const parsed = parseJsonResponse<{ subject?: string; html?: string }>(text);
    if (!parsed.subject || !parsed.html) {
      return {
        subject: fallbackSubject(lead.company_name),
        html: fallbackHtml(lead, meetingNote),
        amount_cents,
        warning: "Claude returned an invalid shape — fallback used.",
      };
    }
    return { subject: parsed.subject.slice(0, 200), html: parsed.html, amount_cents };
  } catch (err) {
    return {
      subject: fallbackSubject(lead.company_name),
      html: fallbackHtml(lead, meetingNote),
      amount_cents,
      warning: isAnthropicUnavailableError(err)
        ? ANTHROPIC_KEY_MISSING_MESSAGE
        : err instanceof Error
          ? err.message
          : String(err),
    };
  }
}

function fallbackSubject(company: string): string {
  return `Proposal — ${company}`;
}

function fallbackHtml(
  lead: ProposalDraftInput["lead"],
  meetingNote: ProposalDraftInput["meetingNote"],
): string {
  const next = meetingNote?.next_steps?.trim();
  return `
<h2>What we heard</h2>
<p>Hi ${lead.contact_name?.split(" ")[0] ?? "there"} — quick recap of the discussion with ${lead.company_name}:</p>
<p>${meetingNote?.notes ?? "[Add the meeting notes recap here.]"}</p>
<h2>What we&apos;re proposing</h2>
<p>[Outline the proposal here — anchored on the agreed next steps.]</p>
<h2>Next step</h2>
<p>${next ? next : "Reply to confirm and we&apos;ll get rolling this week."}</p>`;
}

// ─────────────────────────────────────────────────────────────────────────
// Send — email the lead a /p/[token] link
// ─────────────────────────────────────────────────────────────────────────

export type SendProposalResult =
  | { ok: true; email_sent: boolean; warning?: string }
  | { ok: false; error: string };

export async function sendProposal(
  supabase: Supa,
  proposalId: string,
): Promise<SendProposalResult> {
  const { data: row } = await supabase
    .from("proposals")
    .select("*")
    .eq("id", proposalId)
    .maybeSingle();
  const proposal = row as Proposal | null;
  if (!proposal) return { ok: false, error: `Proposal ${proposalId} not found.` };

  const { data: leadRow } = await supabase
    .from("leads")
    .select("id, company_name, contact_name, email, client_id")
    .eq("id", proposal.lead_id)
    .maybeSingle();
  const lead = leadRow as Pick<Lead, "id" | "company_name" | "contact_name" | "email" | "client_id"> | null;
  if (!lead) return { ok: false, error: `Lead ${proposal.lead_id} not found.` };
  if (!lead.email) return { ok: false, error: `Lead ${lead.company_name} has no email — cannot send.` };

  const suppressed = await isActivelySuppressed(supabase, lead.email);
  if (suppressed) {
    return { ok: false, error: "Lead email is on the suppression list." };
  }

  const sending = await getClientSendingConfig(supabase, lead.client_id);
  const fromEmail = sending.from || FROM_EMAIL;
  const baseUrl = proposalBaseUrl();
  const proposalUrl = `${baseUrl}/p/${proposal.token}`;

  const wrapper = wrapProposalEmail({
    proposalUrl,
    leadName: lead.contact_name?.split(" ")[0] ?? "there",
    senderName: sending.source === "client" ? lead.company_name : "Aylek",
  });

  if (!process.env.RESEND_API_KEY) {
    return {
      ok: true,
      email_sent: false,
      warning: "RESEND_API_KEY not set — proposal row created but no email sent.",
    };
  }

  try {
    await resend.emails.send({
      from: fromEmail,
      to: lead.email,
      subject: proposal.subject,
      html: wrapper,
      replyTo: sending.reply_to || fromEmail,
    });
  } catch (err) {
    return { ok: false, error: `Resend send failed: ${err instanceof Error ? err.message : String(err)}` };
  }

  await logEvent({
    service: true,
    event_type: "email_sent",
    client_id: lead.client_id,
    lead_id: lead.id,
    payload: {
      kind: "close01_proposal_sent",
      proposal_id: proposal.id,
      proposal_url: proposalUrl,
      lead_name: lead.company_name,
      amount_cents: proposal.amount_cents,
    },
  });

  return { ok: true, email_sent: true };
}

function wrapProposalEmail(args: {
  proposalUrl: string;
  leadName: string;
  senderName: string;
}): string {
  return `
<div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif; color: #1d1d1f; max-width: 560px; margin: 0 auto; padding: 24px;">
  <p>Hi ${args.leadName},</p>
  <p>Here&apos;s the proposal we discussed. The full breakdown lives on a single page — click below to view it, and you can accept (or reply with questions) right from there.</p>
  <p style="margin: 32px 0;">
    <a href="${args.proposalUrl}" style="background:#1d1d1f; color:#fff; padding:14px 22px; border-radius:9999px; text-decoration:none; font-weight:600;">Open the proposal</a>
  </p>
  <p style="font-size: 13px; color:#6e6e73;">If the button doesn&apos;t work, paste this link into your browser:<br/><span style="font-family:'SF Mono', Menlo, monospace;">${args.proposalUrl}</span></p>
  <p>— ${args.senderName}</p>
</div>`;
}

function proposalBaseUrl(): string {
  return (
    process.env.PROPOSAL_BASE_URL ??
    process.env.NEXT_PUBLIC_APP_URL ??
    (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : "http://localhost:3000")
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Follow-up — cron sweeps sent / viewed proposals
// ─────────────────────────────────────────────────────────────────────────

const FOLLOWUP_AFTER_SENT_HOURS = 48;
const FLAG_COLD_AFTER_VIEW_HOURS = 24 * 5;

export type SweepResult = {
  followups_sent: number;
  cold_flagged: number;
};

/**
 * One pass over every actionable proposal:
 *  - status='sent', no view in 48h, no follow-up yet → email a nudge,
 *    set followup_sent_at.
 *  - status='viewed', no accept in 5 days, no cold flag yet → open a
 *    deal_cold approval, set cold_flagged_at.
 *
 * Idempotent: the timestamp gates ensure each proposal is only nudged /
 * flagged once. Re-running the cron is safe.
 */
export async function runClose01Sweep(supabase: Supa): Promise<SweepResult> {
  const out: SweepResult = { followups_sent: 0, cold_flagged: 0 };

  const sentCutoff = new Date(Date.now() - FOLLOWUP_AFTER_SENT_HOURS * 3600 * 1000).toISOString();
  const viewCutoff = new Date(Date.now() - FLAG_COLD_AFTER_VIEW_HOURS * 3600 * 1000).toISOString();

  // ── Followups for sent + un-viewed proposals ──────────────────────────
  const { data: stale } = await supabase
    .from("proposals")
    .select("*")
    .eq("status", "sent")
    .is("viewed_at", null)
    .is("followup_sent_at", null)
    .lte("created_at", sentCutoff);
  for (const row of (stale ?? []) as Proposal[]) {
    try {
      const sent = await sendFollowupNudge(supabase, row);
      await supabase
        .from("proposals")
        .update({ followup_sent_at: new Date().toISOString() })
        .eq("id", row.id);
      if (sent.ok && sent.email_sent) out.followups_sent++;
    } catch (err) {
      console.warn(`[close-01 sweep] followup failed for ${row.id}:`, err);
    }
  }

  // ── Cold flagging for viewed-but-not-accepted ─────────────────────────
  const { data: viewed } = await supabase
    .from("proposals")
    .select("*")
    .eq("status", "viewed")
    .is("cold_flagged_at", null)
    .lte("viewed_at", viewCutoff);
  for (const row of (viewed ?? []) as Proposal[]) {
    try {
      await flagCold(supabase, row, "no_accept_5d");
      out.cold_flagged++;
    } catch (err) {
      console.warn(`[close-01 sweep] flagCold failed for ${row.id}:`, err);
    }
  }

  return out;
}

async function sendFollowupNudge(
  supabase: Supa,
  proposal: Proposal,
): Promise<SendProposalResult> {
  const { data: leadRow } = await supabase
    .from("leads")
    .select("id, company_name, contact_name, email, client_id")
    .eq("id", proposal.lead_id)
    .maybeSingle();
  const lead = leadRow as Pick<Lead, "id" | "company_name" | "contact_name" | "email" | "client_id"> | null;
  if (!lead?.email) return { ok: false, error: "Lead missing email." };

  const suppressed = await isActivelySuppressed(supabase, lead.email);
  if (suppressed) return { ok: false, error: "Lead email is on the suppression list." };

  const sending = await getClientSendingConfig(supabase, lead.client_id);
  const baseUrl = proposalBaseUrl();
  const proposalUrl = `${baseUrl}/p/${proposal.token}`;

  if (!process.env.RESEND_API_KEY) {
    return { ok: true, email_sent: false, warning: "RESEND_API_KEY not set." };
  }

  await resend.emails.send({
    from: sending.from || FROM_EMAIL,
    to: lead.email,
    subject: `Re: ${proposal.subject}`,
    replyTo: sending.reply_to || sending.from || FROM_EMAIL,
    html: `<div style="font-family:-apple-system, system-ui, sans-serif; max-width:560px; margin:0 auto; padding:24px; color:#1d1d1f;">
      <p>Hi ${lead.contact_name?.split(" ")[0] ?? "there"},</p>
      <p>Quick nudge in case the proposal slipped past — happy to walk through any of it on a call, or you can open it here:</p>
      <p style="margin:24px 0;"><a href="${proposalUrl}" style="background:#1d1d1f;color:#fff;padding:12px 20px;border-radius:9999px;text-decoration:none;font-weight:600;">Open the proposal</a></p>
      <p>Either way, let me know if anything needs changing.</p>
    </div>`,
  });

  await logEvent({
    service: true,
    event_type: "email_sent",
    client_id: lead.client_id,
    lead_id: lead.id,
    payload: {
      kind: "close01_followup_sent",
      proposal_id: proposal.id,
      lead_name: lead.company_name,
    },
  });

  return { ok: true, email_sent: true };
}

/**
 * Open a `deal_cold` approval for HOS review + stamp the proposal so we
 * don't double-flag. Used by both the cron sweep and the manual "flag
 * this proposal as cold" action.
 */
export async function flagCold(
  supabase: Supa,
  proposal: Proposal,
  reason: DealColdPayload["reason"],
): Promise<{ ok: true; approval_id: string } | { ok: false; error: string }> {
  const { data: leadRow } = await supabase
    .from("leads")
    .select("company_name, client_id")
    .eq("id", proposal.lead_id)
    .maybeSingle();
  const lead = leadRow as { company_name: string; client_id: string | null } | null;
  const clientId = lead?.client_id ?? proposal.client_id;
  if (!clientId) return { ok: false, error: "Cannot flag a proposal with no client_id." };

  const stalenessMs = Date.now() - new Date(proposal.viewed_at ?? proposal.created_at).getTime();
  const stalenessHours = Math.round(stalenessMs / 3600000);

  const payload: DealColdPayload = {
    proposal_id: proposal.id,
    lead_id: proposal.lead_id,
    reason,
    lead_name: lead?.company_name ?? "(unknown lead)",
    proposal_subject: proposal.subject,
    proposal_url: `${proposalBaseUrl()}/p/${proposal.token}`,
    amount_cents: proposal.amount_cents,
    staleness_hours: stalenessHours,
  };

  const { data: appr, error: apprErr } = await supabase
    .from("approvals")
    .insert({
      client_id: clientId,
      type: "deal_cold",
      status: "pending",
      title: `${payload.lead_name}: proposal gone cold (${reason.replace(/_/g, " ")})`,
      summary: `Proposal "${proposal.subject}" stalled for ${stalenessHours}h after ${reason === "no_view_48h" ? "send" : "view"}. Decide: nudge, close, or mark lost.`,
      payload: payload as unknown as Record<string, unknown>,
    })
    .select("id")
    .single();
  if (apprErr || !appr) return { ok: false, error: apprErr?.message ?? "Insert failed" };

  await supabase
    .from("proposals")
    .update({ cold_flagged_at: new Date().toISOString() })
    .eq("id", proposal.id);

  await logEvent({
    service: true,
    event_type: "ai_action",
    client_id: clientId,
    lead_id: proposal.lead_id,
    payload: {
      kind: "close01_proposal_cold",
      proposal_id: proposal.id,
      reason,
      approval_id: appr.id,
      lead_name: payload.lead_name,
    },
  });

  return { ok: true, approval_id: appr.id };
}
