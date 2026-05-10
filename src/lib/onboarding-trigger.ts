/**
 * Trigger that fires after a proposal email is successfully sent: spin up an
 * onboarding_session for the lead's client and email the contact a public
 * link to /onboard/[token].
 *
 * Idempotent — if a non-rejected onboarding_session already exists for the
 * (client_id, lead_id) pair, returns the existing one rather than creating
 * a duplicate (a single proposal-send shouldn't loop the contact through
 * onboarding twice; if HOS resends the proposal later the same session is
 * reused).
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { resend, FROM_EMAIL } from "@/lib/resend";
import { logEvent } from "@/lib/events";
import type { Database, OnboardingSession } from "@/lib/supabase/types";

type Supa = SupabaseClient<Database>;

export type SpawnOnboardingResult =
  | {
      ok: true;
      session: OnboardingSession;
      email_sent: boolean;
      reused_existing: boolean;
      warning?: string;
    }
  | { ok: false; error: string };

export async function spawnOnboardingSession(
  supabase: Supa,
  args: {
    clientId: string;
    leadId: string;
    contactEmail: string;
    contactName: string | null;
    clientName: string;
    userId?: string | null;
  },
): Promise<SpawnOnboardingResult> {
  // 1. Dedup: an existing in-flight session for this (client, lead) wins.
  const { data: existing } = await supabase
    .from("onboarding_sessions")
    .select("*")
    .eq("client_id", args.clientId)
    .eq("lead_id", args.leadId)
    .neq("status", "approved")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (existing) {
    return {
      ok: true,
      session: existing as OnboardingSession,
      email_sent: false,
      reused_existing: true,
    };
  }

  // 2. Insert new session
  const { data: row, error } = await supabase
    .from("onboarding_sessions")
    .insert({
      client_id: args.clientId,
      lead_id: args.leadId,
      status: "pending",
      created_by: args.userId ?? null,
    })
    .select("*")
    .single();
  if (error || !row) {
    return { ok: false, error: error?.message ?? "Failed to create onboarding_session" };
  }
  const session = row as OnboardingSession;

  // 3. Send email
  const sendResult = await sendOnboardingEmail({
    contactEmail: args.contactEmail,
    contactName: args.contactName,
    clientName: args.clientName,
    token: session.token,
  });

  // 4. Stamp sent_at + flip status
  if (sendResult.ok) {
    await supabase
      .from("onboarding_sessions")
      .update({ sent_at: new Date().toISOString() })
      .eq("id", session.id);
  }

  await logEvent({
    event_type: "ai_action",
    client_id: args.clientId,
    lead_id: args.leadId,
    user_id: args.userId ?? null,
    payload: {
      kind: "onboarding_session_created",
      onboarding_session_id: session.id,
      email_sent: sendResult.ok,
      warning: sendResult.ok ? undefined : sendResult.error,
    },
  });

  return {
    ok: true,
    session,
    email_sent: sendResult.ok,
    reused_existing: false,
    warning: sendResult.ok ? undefined : sendResult.error,
  };
}

/** Resend the onboarding email for an existing session. Used by the
 *  client-detail "Resend interview link" button. */
export async function resendOnboardingEmail(
  supabase: Supa,
  sessionId: string,
): Promise<SpawnOnboardingResult> {
  const { data: row } = await supabase
    .from("onboarding_sessions")
    .select("*, leads(email, contact_name), clients(name)")
    .eq("id", sessionId)
    .maybeSingle();
  const r = row as
    | (OnboardingSession & {
        leads: { email: string | null; contact_name: string | null } | null;
        clients: { name: string } | null;
      })
    | null;
  if (!r) return { ok: false, error: "Onboarding session not found" };
  if (!r.leads?.email) return { ok: false, error: "Linked lead has no email address" };

  const sendResult = await sendOnboardingEmail({
    contactEmail: r.leads.email,
    contactName: r.leads.contact_name ?? null,
    clientName: r.clients?.name ?? "your team",
    token: r.token,
  });

  if (sendResult.ok) {
    await supabase
      .from("onboarding_sessions")
      .update({ sent_at: new Date().toISOString() })
      .eq("id", r.id);
  }

  return {
    ok: true,
    session: r,
    email_sent: sendResult.ok,
    reused_existing: true,
    warning: sendResult.ok ? undefined : sendResult.error,
  };
}

async function sendOnboardingEmail(args: {
  contactEmail: string;
  contactName: string | null;
  clientName: string;
  token: string;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const baseUrl = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";
  const link = `${baseUrl}/onboard/${args.token}`;
  const firstName = (args.contactName ?? "").split(" ")[0] || "there";

  const subject = `Set up your ${args.clientName} sales system`;
  const body = `Hi ${firstName},

Thanks for the proposal review — I've sent it through. Now the fun bit: building the sales system that runs in the background for ${args.clientName}.

I've put together a short interview for you. It takes about 15 minutes, asks one question at a time, and uses your answers to draft your full sales playbook — your ICP, messaging, voice & tone, sequences, the lot. You'll get to review and tweak the draft before anything goes live.

Open it here:
${link}

This link is unique to ${args.clientName}, so don't share it. Reply to this email if you hit anything strange.

Talk soon,
Aylek Sales`;

  try {
    const result = await resend.emails.send({
      from: FROM_EMAIL,
      to: args.contactEmail,
      subject,
      text: body,
      replyTo: FROM_EMAIL,
    });
    if (result.error) throw new Error(result.error.message);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
