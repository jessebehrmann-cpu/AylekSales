/**
 * Global suppression list — emails we will NEVER contact again, no matter
 * which client owns the lead.
 *
 * Population paths:
 *   - explicit unsubscribe click (/u/[token])
 *   - inbound webhook classifies a reply as "unsubscribe"
 *   - Resend bounce / complaint webhook
 *   - manual admin add
 *
 * Every outbound Resend send-site MUST check this before sending.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { logEvent } from "@/lib/events";
import type {
  Database,
  SuppressedEmail,
  SuppressedEmailReason,
} from "@/lib/supabase/types";

type Supa = SupabaseClient<Database>;

/** Check whether the given email is on the suppression list. */
export async function isSuppressed(
  supabase: Supa,
  email: string,
): Promise<boolean> {
  const normalised = email.trim().toLowerCase();
  if (!normalised) return false;
  const { data } = await supabase
    .from("suppressed_emails")
    .select("email")
    .eq("email", normalised)
    .limit(1)
    .maybeSingle();
  return !!data;
}

/** Bulk check — useful for cron loops processing many candidates. */
export async function suppressedEmailsIn(
  supabase: Supa,
  emails: string[],
): Promise<Set<string>> {
  const normalised = emails
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  if (normalised.length === 0) return new Set();
  const { data } = await supabase
    .from("suppressed_emails")
    .select("email")
    .in("email", normalised);
  return new Set(((data ?? []) as Array<{ email: string }>).map((r) => r.email));
}

/**
 * Add an email to the suppression list. Idempotent (existing row stays;
 * upsert keeps the original suppressed_at + token). Logs an `ai_action`
 * event so HOS can see suppressions in the activity feed.
 */
export async function suppress(
  supabase: Supa,
  args: {
    email: string;
    reason: SuppressedEmailReason;
    sourceLeadId?: string | null;
    sourceClientId?: string | null;
    notes?: string | null;
  },
): Promise<SuppressedEmail | null> {
  const normalised = args.email.trim().toLowerCase();
  if (!normalised) return null;
  // ON CONFLICT DO NOTHING: keep the original suppression timestamp.
  const { data, error } = await supabase
    .from("suppressed_emails")
    .insert({
      email: normalised,
      reason: args.reason,
      source_lead_id: args.sourceLeadId ?? null,
      source_client_id: args.sourceClientId ?? null,
      notes: args.notes ?? null,
    })
    .select("*")
    .maybeSingle();
  // 23505 = unique violation = email already suppressed. That's fine.
  if (error && error.code !== "23505") {
    console.error("[suppression] insert failed", error);
    return null;
  }
  if (data) {
    await logEvent({
      service: true,
      event_type: "ai_action",
      client_id: args.sourceClientId ?? null,
      lead_id: args.sourceLeadId ?? null,
      payload: {
        kind: "email_suppressed",
        email: normalised,
        reason: args.reason,
        notes: args.notes ?? null,
      },
    });
  }
  return (data as SuppressedEmail | null) ?? null;
}

/**
 * Build the unsubscribe URL appended to outbound bodies. Generates a
 * stable token per email — first call mints the row; subsequent calls
 * read it back. Returns null only when DB writes fail.
 */
export async function getUnsubscribeUrl(
  supabase: Supa,
  args: {
    email: string;
    clientId: string | null;
    leadId: string | null;
  },
): Promise<string | null> {
  const baseUrl = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";
  const normalised = args.email.trim().toLowerCase();
  if (!normalised) return null;

  // Check if there's already a row (suppressed or not). We don't suppress
  // here — we just need the stable token.
  const { data: existing } = await supabase
    .from("suppressed_emails")
    .select("unsubscribe_token")
    .eq("email", normalised)
    .maybeSingle();

  if (existing) {
    return `${baseUrl}/u/${(existing as { unsubscribe_token: string }).unsubscribe_token}`;
  }

  // No row yet — create a placeholder one with reason='manual' BUT mark
  // it as not-yet-suppressed via a sentinel. Cleaner approach: pre-create
  // a token but with NULL suppressed_at? The schema requires
  // suppressed_at (default now()). We use reason='manual' but interpret
  // it as "pending" downstream: the /u/[token] route flips it to
  // reason='unsubscribe' on click.
  //
  // Better: a separate `outbound_recipients` table for tokens. Cheaper
  // here: just create the suppression row with reason='manual' + an
  // 'unsubscribe_pending' note. The flow assumes the email exists and
  // the row is the token holder, not a hard suppression marker.
  //
  // For Phase 9 keep it simple: pre-create a row with reason='manual'
  // and a `pending_token` note. The /u/[token] route promotes the
  // reason to 'unsubscribe' on click and clears the note. Outbound
  // checks `reason in ('unsubscribe','bounce','complaint','manual'
  // WHERE notes != 'pending_token')` via the helper below.
  const { data: created, error } = await supabase
    .from("suppressed_emails")
    .insert({
      email: normalised,
      reason: "manual",
      source_lead_id: args.leadId,
      source_client_id: args.clientId,
      notes: "pending_token",
    })
    .select("unsubscribe_token")
    .single();
  if (error || !created) {
    console.error("[suppression] failed to mint token", error);
    return null;
  }
  return `${baseUrl}/u/${(created as { unsubscribe_token: string }).unsubscribe_token}`;
}

/**
 * Variant of isSuppressed that excludes the "pending_token" rows
 * created by getUnsubscribeUrl — those exist solely to host a token,
 * the email hasn't actually unsubscribed.
 */
export async function isActivelySuppressed(
  supabase: Supa,
  email: string,
): Promise<boolean> {
  const normalised = email.trim().toLowerCase();
  if (!normalised) return false;
  const { data } = await supabase
    .from("suppressed_emails")
    .select("reason, notes")
    .eq("email", normalised)
    .maybeSingle();
  if (!data) return false;
  const row = data as { reason: SuppressedEmailReason; notes: string | null };
  // The 'pending_token' marker means we minted a token but the contact
  // hasn't clicked unsubscribe yet — not actually suppressed.
  if (row.reason === "manual" && row.notes === "pending_token") return false;
  return true;
}

/**
 * Bulk variant. Returns Set<email> of emails that are actively suppressed.
 */
export async function activelySuppressedEmailsIn(
  supabase: Supa,
  emails: string[],
): Promise<Set<string>> {
  const normalised = emails.map((e) => e.trim().toLowerCase()).filter(Boolean);
  if (normalised.length === 0) return new Set();
  const { data } = await supabase
    .from("suppressed_emails")
    .select("email, reason, notes")
    .in("email", normalised);
  const out = new Set<string>();
  for (const row of (data ?? []) as Array<{
    email: string;
    reason: SuppressedEmailReason;
    notes: string | null;
  }>) {
    if (row.reason === "manual" && row.notes === "pending_token") continue;
    out.add(row.email);
  }
  return out;
}
