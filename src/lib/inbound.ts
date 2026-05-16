import { createServiceClient } from "@/lib/supabase/server";
import {
  anthropic,
  ANTHROPIC_MODEL,
  isAnthropicKeyMissing,
  isAnthropicUnavailableError,
  parseJsonResponse,
} from "@/lib/anthropic";
import { suppress } from "@/lib/suppression";
import { buildBookingLink, pickTeamMember } from "@/lib/calendar/cal-com";
import { logEvent } from "@/lib/events";
import type {
  ClientCalendarConfig,
  Playbook,
  ReplyKind,
  ReplyReviewPayload,
} from "@/lib/supabase/types";

/** Catch obvious unsubscribe phrasing in the inbound body/subject before
 *  spending a Claude call. Conservative — only trigger when the contact
 *  has explicitly asked. */
const UNSUB_REGEX =
  /\b(unsubscribe|remove me|take me off|do not (contact|email)|stop emailing|please stop)\b/i;

export type InboundEmail = {
  from_email: string;
  from_name?: string;
  to_email?: string;
  subject?: string;
  text?: string;
  html?: string;
  message_id?: string;
};

type Qualification = {
  reply_kind: ReplyKind;
  is_genuine: boolean;
  quality: "hot" | "warm" | "cold";
  reasoning: string;
};

/**
 * Process one inbound email:
 *  1. Match or create the lead by email
 *  2. Store the inbound email row
 *  3. Call Claude to qualify the enquiry
 *  4. Auto-send the AI-suggested response (best-effort)
 *  5. Log inbound_received + inbound_qualified events
 */
export async function processInboundEmail(payload: InboundEmail): Promise<void> {
  const supabase = createServiceClient();
  const fromEmail = payload.from_email.trim().toLowerCase();
  if (!fromEmail) return;

  // Match an existing lead by email (any client). If multiple, pick the
  // most-recent one — operator can re-assign later.
  const { data: existing } = await supabase
    .from("leads")
    .select("id, company_name, contact_name, client_id")
    .eq("email", fromEmail)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  // Fast-path: explicit unsubscribe text in body or subject. Suppress
  // immediately, flip lead.stage to unsubscribed, and bail before
  // spending a Claude call.
  const haystack = `${payload.subject ?? ""}\n${payload.text ?? ""}`;
  if (UNSUB_REGEX.test(haystack)) {
    if (existing?.id) {
      await supabase
        .from("leads")
        .update({ stage: "unsubscribed" })
        .eq("id", existing.id);
      await supabase
        .from("emails")
        .update({ status: "failed" })
        .eq("lead_id", existing.id)
        .eq("status", "pending");
    }
    await suppress(supabase, {
      email: fromEmail,
      reason: "unsubscribe",
      sourceLeadId: existing?.id ?? null,
      sourceClientId: existing?.client_id ?? null,
      notes: `Inbound reply matched unsubscribe regex: subject="${(payload.subject ?? "").slice(0, 80)}"`,
    });
    await logEvent({
      service: true,
      event_type: "inbound_received",
      lead_id: existing?.id ?? null,
      client_id: existing?.client_id ?? null,
      payload: {
        kind: "unsubscribe_request",
        from_email: fromEmail,
      },
    });
    return;
  }

  let leadId = existing?.id ?? null;
  let clientId = existing?.client_id ?? null;
  const leadName = existing?.company_name ?? (payload.from_name || fromEmail);

  if (!leadId) {
    const { data: created, error } = await supabase
      .from("leads")
      .insert({
        company_name: payload.from_name || fromEmail,
        contact_name: payload.from_name ?? null,
        email: fromEmail,
        source: "inbound",
        stage: "replied",
      })
      .select("id, client_id")
      .single();
    if (error || !created) {
      console.error("[inbound] failed to create lead", error);
      return;
    }
    leadId = created.id;
    clientId = created.client_id;
  } else {
    // Existing lead: bump to 'replied' so the send-loop stops further outreach.
    await supabase.from("leads").update({ stage: "replied" }).eq("id", leadId);
  }

  // Store the inbound email row
  await supabase.from("emails").insert({
    lead_id: leadId,
    client_id: clientId,
    direction: "inbound",
    subject: payload.subject ?? null,
    body: payload.text ?? null,
    reply_body: payload.text ?? null,
    status: "replied",
    sent_at: null,
    replied_at: new Date().toISOString(),
    resend_message_id: payload.message_id ?? null,
  });

  await logEvent({
    service: true,
    event_type: "inbound_received",
    lead_id: leadId,
    client_id: clientId,
    payload: {
      lead_name: leadName,
      from: fromEmail,
      subject: payload.subject ?? null,
    },
  });

  // ── Classify the reply + draft a response into a reply_review approval ──
  if (isAnthropicKeyMissing()) {
    console.warn("[inbound] ANTHROPIC_API_KEY missing — skipping reply classification");
    return;
  }

  // Load playbook (for reply_strategy + team_members) + calendar_config.
  let playbook: Playbook | null = null;
  let calendarConfig: ClientCalendarConfig | null = null;
  if (clientId) {
    const { data: pb } = await supabase
      .from("playbooks")
      .select("*")
      .eq("client_id", clientId)
      .eq("status", "approved")
      .maybeSingle();
    playbook = (pb as Playbook | null) ?? null;
    const { data: cl } = await supabase
      .from("clients")
      .select("calendar_config")
      .eq("id", clientId)
      .maybeSingle();
    calendarConfig =
      (cl as { calendar_config?: ClientCalendarConfig | null } | null)?.calendar_config ??
      null;
  }

  // Classify (single Claude call) + draft the response anchored on the
  // playbook's reply_strategy template (if present).
  try {
    const replyStrategy = playbook?.reply_strategy ?? {};
    const voiceTone = playbook?.voice_tone ?? {};
    const teamMember = playbook && leadId ? pickTeamMember(playbook, leadId) : null;
    const bookingLink =
      clientId && leadId
        ? buildBookingLink({
            clientId,
            leadId,
            leadEmail: fromEmail,
            leadContactName: payload.from_name ?? null,
            teamMember,
            calendarConfig,
          })
        : null;

    const system = `You are an AI sales assistant. Classify an inbound reply into one of these ReplyKind values, then draft a professional response in the supplied voice & tone.

ReplyKind values:
- interested: lead is open / wants more info / wants to book a meeting.
- not_now: politely declining, asks to follow up later.
- wrong_person: not the right contact at the company.
- objection: pushing back on something specific (price, fit, timing).

You ALWAYS return a single JSON object, no markdown:
{
  "reply_kind": "interested" | "not_now" | "wrong_person" | "objection",
  "is_genuine": true | false,
  "quality": "hot" | "warm" | "cold",
  "reasoning": "one sentence",
  "drafted_subject": "...",
  "drafted_body": "..."
}

Drafted body rules:
- Match the supplied voice & tone exactly.
- 3-5 sentences max. No greeting like "Hi {{contact_name}}" unless the voice prefers it.
- If reply_kind=interested AND a booking link is supplied, embed it explicitly so the prospect can self-book.
- If reply_kind=wrong_person, ask politely for the right contact.
- Never quote price. Never use template language ("circling back", "synergy", "just touching base").
- Use the reply_strategy.<kind>.template as a starting point when supplied.`;

    const prompt = `Inbound from ${payload.from_name || fromEmail} <${fromEmail}>

Subject: ${payload.subject ?? "(no subject)"}

${payload.text ?? "(no body)"}

PLAYBOOK reply_strategy (templates we'd prefer to use as starting points):
${JSON.stringify(replyStrategy, null, 2)}

VOICE & TONE:
${JSON.stringify(voiceTone, null, 2)}

${bookingLink ? `BOOKING LINK (embed verbatim in body when reply_kind=interested):\n${bookingLink}\n` : ""}

Classify and draft.`;

    const response = await anthropic.messages.create({
      model: ANTHROPIC_MODEL,
      max_tokens: 1200,
      system,
      messages: [{ role: "user", content: prompt }],
    });
    const text = response.content[0]?.type === "text" ? response.content[0].text : "";
    const q = parseJsonResponse<
      Qualification & { drafted_subject?: string; drafted_body?: string }
    >(text);

    await logEvent({
      service: true,
      event_type: q.is_genuine ? "inbound_qualified" : "inbound_disqualified",
      lead_id: leadId,
      client_id: clientId,
      payload: {
        lead_name: leadName,
        reply_kind: q.reply_kind,
        quality: q.quality,
        reasoning: q.reasoning,
      },
    });

    if (!q.drafted_subject || !q.drafted_body) {
      console.warn("[inbound] Claude returned no draft — no reply_review created");
      return;
    }

    // Don't create reply_reviews without a client_id (approvals.client_id
    // is NOT NULL). Orphaned inbounds get logged only.
    if (!clientId || !leadId) return;

    const replyPayload: ReplyReviewPayload = {
      lead_id: leadId,
      reply_kind: q.reply_kind,
      incoming_subject: payload.subject ?? null,
      incoming_excerpt: (payload.text ?? "").slice(0, 500),
      drafted_subject: q.drafted_subject.slice(0, 200),
      drafted_body: q.drafted_body,
      booking_link: bookingLink,
    };

    await supabase.from("approvals").insert({
      client_id: clientId,
      type: "reply_review",
      status: "pending",
      title: `${leadName}: review reply (${q.reply_kind})`,
      summary: `Inbound classified as ${q.reply_kind} (${q.quality}). Drafted response ready — HOS to review + send.`,
      payload: replyPayload as unknown as Record<string, unknown>,
      related_playbook_id: playbook?.id ?? null,
    });
  } catch (qualifyErr) {
    if (isAnthropicUnavailableError(qualifyErr)) {
      console.warn("[inbound] Anthropic unavailable — classification skipped");
    } else {
      console.error("[inbound] classification failed", qualifyErr);
    }
  }
}
