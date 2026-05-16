/**
 * Cal.com integration helpers.
 *
 * Bookings are surfaced via Cal.com webhooks (BOOKING_CREATED /
 * RESCHEDULED / CANCELLED). The agent generates per-lead booking links
 * that the contact clicks. When they book we get a webhook → advance
 * the lead to `have_meeting` + create a meetings row.
 *
 * Booking link format:
 *   https://cal.com/{cal_link}?
 *     email={lead.email}
 *     &name={lead.contact_name}
 *     &metadata[lead_id]={lead.id}
 *     &metadata[client_id]={client.id}
 *     &metadata[aylek]=1
 *
 * Cal.com passes `metadata` back to us in the webhook payload, which is
 * how we link the booking to the right lead.
 */

import type {
  ClientCalendarConfig,
  Playbook,
  TeamMember,
} from "@/lib/supabase/types";

const CAL_BASE = "https://cal.com";

export type BookingLinkArgs = {
  clientId: string;
  leadId: string;
  leadEmail: string | null;
  leadContactName: string | null;
  /** The playbook's assigned team member for this lead — picked by the
   *  agent based on round-robin or sequence rules. */
  teamMember: TeamMember | null;
  calendarConfig: ClientCalendarConfig | null;
};

/**
 * Build a Cal.com booking URL for the given lead. Returns null when:
 *   - the client has no calendar_config, OR
 *   - no team_member_link matches the supplied team member.
 *
 * The link prefills the lead's email + name + metadata so the webhook
 * can link the booking back to our row.
 */
export function buildBookingLink(args: BookingLinkArgs): string | null {
  if (!args.calendarConfig) return null;
  const links = args.calendarConfig.team_member_links;
  if (!links || links.length === 0) return null;

  // Pick the matching link, else fall back to the first one.
  const match =
    (args.teamMember && links.find((l) => l.team_member_id === args.teamMember!.id)) ??
    links[0];
  if (!match?.cal_link) return null;

  const params = new URLSearchParams();
  if (args.leadEmail) params.set("email", args.leadEmail);
  if (args.leadContactName) params.set("name", args.leadContactName);
  params.set("metadata[lead_id]", args.leadId);
  params.set("metadata[client_id]", args.clientId);
  params.set("metadata[aylek]", "1");
  return `${CAL_BASE}/${match.cal_link.replace(/^\//, "")}?${params.toString()}`;
}

/**
 * Pick a team member from the playbook to assign for a given lead.
 * Simple round-robin by lead id hash today — Phase 12 can swap to a
 * smarter assignment.
 */
export function pickTeamMember(
  playbook: Playbook | null,
  leadId: string,
): TeamMember | null {
  const team = playbook?.team_members ?? [];
  if (team.length === 0) return null;
  // Stable hash of the lead id → index into team[]
  let h = 0;
  for (const c of leadId) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return team[h % team.length] ?? null;
}

// ─────────────────────────────────────────────────────────────────────────
// Webhook payload normalisation
// ─────────────────────────────────────────────────────────────────────────

export type CalWebhookKind =
  | "BOOKING_CREATED"
  | "BOOKING_RESCHEDULED"
  | "BOOKING_CANCELLED";

export type NormalisedCalBooking = {
  kind: CalWebhookKind;
  cal_booking_id: string;
  cal_booking_url: string | null;
  scheduled_at: string | null;
  duration_minutes: number | null;
  attendee_email: string | null;
  /** Metadata we attached when generating the booking link. */
  metadata: {
    lead_id?: string;
    client_id?: string;
    aylek?: string;
  };
};

/**
 * Parse a Cal.com webhook payload into a uniform shape. Returns null
 * when the event isn't a booking-lifecycle event we care about.
 */
export function normaliseCalWebhook(raw: unknown): NormalisedCalBooking | null {
  const r = raw as {
    triggerEvent?: string;
    type?: string;
    payload?: {
      uid?: string;
      bookerUrl?: string;
      startTime?: string;
      length?: number;
      attendees?: Array<{ email?: string }>;
      metadata?: Record<string, string>;
    };
  };
  const trigger = (r.triggerEvent ?? r.type ?? "").toUpperCase();
  if (
    trigger !== "BOOKING_CREATED" &&
    trigger !== "BOOKING_RESCHEDULED" &&
    trigger !== "BOOKING_CANCELLED"
  ) {
    return null;
  }
  const p = r.payload;
  if (!p?.uid) return null;
  return {
    kind: trigger as CalWebhookKind,
    cal_booking_id: p.uid,
    cal_booking_url: p.bookerUrl ?? null,
    scheduled_at: p.startTime ?? null,
    duration_minutes: typeof p.length === "number" ? p.length : null,
    attendee_email: p.attendees?.[0]?.email ?? null,
    metadata: (p.metadata ?? {}) as NormalisedCalBooking["metadata"],
  };
}
