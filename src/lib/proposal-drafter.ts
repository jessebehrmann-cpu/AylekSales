/**
 * Claude-backed playbook proposal drafter. Used when a lead reaches the
 * Send Proposal stage without meeting-notes context (e.g. manual stage
 * advancement, backfill, or future workflows). Anchors the draft on the
 * client's playbook strategy, voice & tone, and team voice so HOS gets a
 * real first-draft proposal — not a placeholder — to edit and send.
 *
 * Distinct from `draftFollowUpProposal` in leads/actions.ts, which uses
 * meeting transcript / objections / next_steps to anchor a post-meeting
 * follow-up. This drafter is the no-meeting-context fallback.
 */

import {
  anthropic,
  ANTHROPIC_KEY_MISSING_MESSAGE,
  ANTHROPIC_MODEL,
  isAnthropicKeyMissing,
  isAnthropicUnavailableError,
  parseJsonResponse,
} from "@/lib/anthropic";
import type { Playbook } from "@/lib/supabase/types";

export type ProposalDraft = {
  subject: string;
  body: string;
  warning?: string;
};

export type ProposalDrafterLead = {
  company_name: string;
  contact_name: string | null;
  title: string | null;
  industry: string | null;
};

/**
 * Draft a proposal email anchored on the playbook + lead. Always returns a
 * usable subject/body — when Claude is unavailable, falls back to a
 * playbook-shaped fallback that uses the value proposition + key messages
 * directly so the draft is still editable and not a literal "[fill this
 * in]" placeholder.
 */
export async function draftProposalFromPlaybook(args: {
  playbook: Playbook | null;
  lead: ProposalDrafterLead;
}): Promise<ProposalDraft> {
  const { playbook, lead } = args;
  const firstName = (lead.contact_name ?? "").split(" ")[0] || "there";

  if (isAnthropicKeyMissing()) {
    return playbookFallback(playbook, lead, firstName, ANTHROPIC_KEY_MISSING_MESSAGE);
  }

  const strategy = playbook?.strategy ?? {};
  const voice = playbook?.voice_tone ?? {};
  const team = playbook?.team_members ?? [];
  const senderName = team[0]?.name ?? "the team";

  const system = `You write outbound B2B proposal emails on behalf of a client team. Anchor every line on the supplied STRATEGY and VOICE & TONE. Reference the lead's company by name. Open with the contact's first name. Body is 4-7 short sentences max with one concrete value proposition and one explicit next-step CTA (typically a 20-30 minute call). No price talk. No marketing fluff. Sign off with the team's voice.`;

  const prompt = `Draft a proposal email to ${lead.company_name}.

LEAD
- Contact: ${lead.contact_name ?? "(unknown)"}
- Title: ${lead.title ?? "(unknown)"}
- Company: ${lead.company_name}
- Industry: ${lead.industry ?? "(unknown)"}

CONTEXT
This lead reached the Send Proposal stage without prior meeting notes. Treat
this as a first-touch proposal anchored on the playbook strategy + voice &
tone, not a follow-up to a specific conversation. Do not invent meeting
context.

STRATEGY (value prop, key messages, proof points)
${JSON.stringify(strategy, null, 2)}

VOICE & TONE
${JSON.stringify(voice, null, 2)}

TEAM (use first member as the sender unless voice says otherwise)
${JSON.stringify(team.slice(0, 3), null, 2)}

Return ONLY valid JSON with this shape, no markdown, no commentary:
{"subject": "...", "body": "..."}

Subject must be under 70 characters and reference ${lead.company_name} or
the value proposition. Body opens with "${firstName}" (case per voice
preference), runs 4-7 sentences, ends with the next-step CTA, and signs off
with ${senderName}'s name.`;

  try {
    const response = await anthropic.messages.create({
      model: ANTHROPIC_MODEL,
      max_tokens: 1500,
      system,
      messages: [{ role: "user", content: prompt }],
    });
    const text = response.content[0]?.type === "text" ? response.content[0].text : "";
    const parsed = parseJsonResponse<{ subject?: string; body?: string }>(text);
    if (!parsed.subject || !parsed.body) {
      return playbookFallback(playbook, lead, firstName, "AI returned an invalid shape — playbook fallback used.");
    }
    return {
      subject: parsed.subject.slice(0, 200),
      body: parsed.body,
    };
  } catch (err) {
    if (isAnthropicUnavailableError(err)) {
      return playbookFallback(playbook, lead, firstName, ANTHROPIC_KEY_MISSING_MESSAGE);
    }
    return playbookFallback(
      playbook,
      lead,
      firstName,
      err instanceof Error ? err.message : String(err),
    );
  }
}

/**
 * Build a usable proposal from the playbook directly when Claude is
 * unavailable. Pulls the value proposition + a couple of key messages
 * verbatim so the draft is still real text HOS can edit, not a TODO.
 */
function playbookFallback(
  playbook: Playbook | null,
  lead: ProposalDrafterLead,
  firstName: string,
  warning: string,
): ProposalDraft {
  const strategy = playbook?.strategy ?? {};
  const team = playbook?.team_members ?? [];
  const sender = team[0]?.name ?? "the team";

  const valueProp =
    strategy.value_proposition ??
    `We help teams like ${lead.company_name} move faster on what matters most.`;
  const keyMessages = (strategy.key_messages ?? []).slice(0, 2);

  const subject = `${lead.company_name}: a quick proposal`;
  const lines = [
    `Hi ${firstName},`,
    "",
    `${valueProp}`,
  ];
  if (keyMessages.length > 0) {
    lines.push("");
    lines.push("A few specifics that map to teams in your space:");
    for (const m of keyMessages) lines.push(`- ${m}`);
  }
  lines.push("");
  lines.push(
    `Would a 20-minute call next week be useful to walk through what this could look like for ${lead.company_name}?`,
  );
  lines.push("");
  lines.push(`Thanks,`);
  lines.push(sender);

  return {
    subject,
    body: lines.join("\n"),
    warning,
  };
}
