import { createServiceClient } from "@/lib/supabase/server";
import {
  anthropic,
  ANTHROPIC_MODEL,
  isAnthropicKeyMissing,
  isAnthropicUnavailableError,
  parseJsonResponse,
} from "@/lib/anthropic";
import { resend, FROM_EMAIL } from "@/lib/resend";
import { getClientSendingConfig } from "@/lib/email-config";
import { suppress } from "@/lib/suppression";
import { logEvent } from "@/lib/events";

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
  is_genuine: boolean;
  quality: "hot" | "warm" | "cold";
  estimated_size: "small" | "medium" | "large";
  suggested_response: string;
  next_action: "send_quote" | "book_meeting" | "request_more_info" | "disqualify";
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

  // ── AI qualification ──────────────────────────────────────────────────────
  if (isAnthropicKeyMissing()) {
    console.warn("[inbound] ANTHROPIC_API_KEY missing — skipping AI qualification");
    return;
  }

  try {
    const system =
      "You are an AI sales assistant for a B2B company. You assess inbound enquiries quickly and write warm, direct responses. Never quote prices.";

    const prompt = `Inbound email from ${payload.from_name || fromEmail} <${fromEmail}>:

Subject: ${payload.subject ?? "(no subject)"}

${payload.text ?? "(no body)"}

Assess:
1. Is this a genuine inbound sales enquiry? (true/false)
2. Lead quality: "hot" / "warm" / "cold"
3. Estimated contract size: "small" / "medium" / "large"
4. Write a suggested response email body (3-5 sentences max, no greeting line, sign off as "Aylek Sales").
5. Next action: "send_quote" / "book_meeting" / "request_more_info" / "disqualify"
6. One sentence of reasoning.

Return ONLY valid JSON with these keys: is_genuine, quality, estimated_size, suggested_response, next_action, reasoning. No markdown.`;

    const response = await anthropic.messages.create({
      model: ANTHROPIC_MODEL,
      max_tokens: 1200,
      system,
      messages: [{ role: "user", content: prompt }],
    });

    const text = response.content[0]?.type === "text" ? response.content[0].text : "";
    const q = parseJsonResponse<Qualification>(text);

    await logEvent({
      service: true,
      event_type: q.is_genuine ? "inbound_qualified" : "inbound_disqualified",
      lead_id: leadId,
      client_id: clientId,
      payload: {
        lead_name: leadName,
        quality: q.quality,
        estimated_size: q.estimated_size,
        next_action: q.next_action,
        reasoning: q.reasoning,
      },
    });

    if (q.is_genuine && q.next_action !== "disqualify") {
      // Auto-send the AI's suggested reply, from the per-client domain.
      const sendingCfg = await getClientSendingConfig(supabase, clientId);
      try {
        const sendResult = await resend.emails.send({
          from: sendingCfg.from,
          to: fromEmail,
          subject: payload.subject ? `Re: ${payload.subject.replace(/^Re:\s*/i, "")}` : "Thanks for getting in touch",
          text: q.suggested_response,
          replyTo: sendingCfg.reply_to,
        });
        if (sendResult.error) throw new Error(sendResult.error.message);

        await supabase.from("emails").insert({
          lead_id: leadId,
          client_id: clientId,
          direction: "outbound",
          subject: payload.subject ? `Re: ${payload.subject.replace(/^Re:\s*/i, "")}` : "Thanks for getting in touch",
          body: q.suggested_response,
          status: "sent",
          sent_at: new Date().toISOString(),
          resend_message_id: sendResult.data?.id ?? null,
        });

        await logEvent({
          service: true,
          event_type: "ai_action",
          lead_id: leadId,
          client_id: clientId,
          payload: {
            kind: "auto_reply_sent",
            lead_name: leadName,
            next_action: q.next_action,
          },
        });
      } catch (sendErr) {
        console.error("[inbound] auto-reply send failed", sendErr);
      }
    }
  } catch (qualifyErr) {
    if (isAnthropicUnavailableError(qualifyErr)) {
      console.warn("[inbound] Anthropic unavailable — qualification skipped");
    } else {
      console.error("[inbound] qualification failed", qualifyErr);
    }
  }
}
