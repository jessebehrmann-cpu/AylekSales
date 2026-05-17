/**
 * Plain-English formatter for the append-only events table.
 *
 * Every row in `public.events` has an `event_type` enum + a `payload`
 * jsonb. This module turns those into a single human-readable sentence
 * + a status indicator + an optional secondary line of detail. The UI
 * surfaces the headline prominently and demotes the raw event_type
 * code to a small monospace badge on the right.
 *
 * Rule: when adding a new logEvent() call site, also add the matching
 * case here. Falling through to the default formatter is fine — the
 * test/formatter will still produce something readable — but adding the
 * specific case sharpens the wording.
 */

import type { AppEvent } from "@/lib/supabase/types";

export type EventStatus = "ok" | "warn" | "fail" | "info";

export type FormattedEvent = {
  headline: string;
  detail?: string;
  status: EventStatus;
  /** Short identifier surfaced as a badge — usually the agent name when
   *  the event was an agent action, or null for system events. */
  source?: string;
};

type Payload = Record<string, unknown>;

function s(p: Payload, k: string): string | null {
  const v = p[k];
  return typeof v === "string" && v.trim() ? v : null;
}
function n(p: Payload, k: string): number | null {
  const v = p[k];
  return typeof v === "number" ? v : null;
}

const FALLBACK: FormattedEvent = { headline: "Event recorded", status: "info" };

export function describeEvent(event: Pick<AppEvent, "event_type" | "payload">): FormattedEvent {
  const p = (event.payload ?? {}) as Payload;
  const kind = s(p, "kind") ?? "";
  const lead = s(p, "lead_name") ?? "this lead";
  const company = s(p, "company_name");
  const client = s(p, "client_name");

  switch (event.event_type) {
    // ── Email lifecycle ──────────────────────────────────────────
    case "email_sent":
      if (kind === "proposal_sent") {
        return {
          headline: `Proposal email sent to ${lead}`,
          detail: s(p, "subject") ?? undefined,
          status: "ok",
          source: "Close-01",
        };
      }
      if (kind === "reply_sent") {
        return {
          headline: `Reply sent to ${lead}`,
          detail: s(p, "subject") ?? undefined,
          status: "ok",
          source: "Sales-01",
        };
      }
      return {
        headline: `Email sent to ${lead}`,
        detail: s(p, "subject") ?? undefined,
        status: "ok",
        source: "Outreach-01",
      };

    case "email_opened":
      return { headline: `${lead} opened the email`, status: "ok", source: "Outreach-01" };

    case "email_replied":
      return { headline: `${lead} replied`, status: "ok", source: "Sales-01" };

    case "email_bounced":
      return {
        headline: `Email to ${lead} ${kind === "email.complained" ? "marked as spam" : "bounced"}`,
        detail: "Auto-unsubscribed + added to suppression list",
        status: "fail",
      };

    // ── Inbound ──────────────────────────────────────────────────
    case "inbound_received":
      if (kind === "unsubscribe_request") {
        return {
          headline: `${lead} asked to unsubscribe`,
          detail: "Auto-suppressed + outreach cancelled",
          status: "ok",
        };
      }
      return {
        headline: `Inbound reply from ${lead}`,
        detail: s(p, "from") ?? s(p, "from_email") ?? undefined,
        status: "info",
      };
    case "inbound_qualified": {
      const replyKind = s(p, "reply_kind");
      const quality = s(p, "quality");
      return {
        headline: `${lead}: classified ${replyKind ?? "interested"}${quality ? ` (${quality})` : ""}`,
        detail: s(p, "reasoning") ?? undefined,
        status: "ok",
        source: "Sales-01",
      };
    }
    case "inbound_disqualified":
      return {
        headline: `${lead}: classified as not a fit`,
        detail: s(p, "reasoning") ?? undefined,
        status: "warn",
        source: "Sales-01",
      };

    // ── Stage transitions ────────────────────────────────────────
    case "stage_changed":
      if (kind === "stage_engine_transition") {
        const before = s(p, "before");
        const after = s(p, "stage_name") ?? s(p, "after");
        if (before && after) {
          return {
            headline: `${lead} advanced ${before} → ${after}`,
            status: "ok",
          };
        }
        return { headline: `${lead} advanced to ${after ?? "next stage"}`, status: "ok" };
      }
      if (kind === "human_stage_completed_end_of_pipeline") {
        return { headline: `${lead}: end of pipeline reached`, status: "ok" };
      }
      if (kind === "unsubscribed_via_link" || kind === "unsubscribed_via_button") {
        return { headline: `${lead} unsubscribed`, status: "warn" };
      }
      return { headline: `${lead}: stage changed`, status: "info" };

    case "meeting_booked":
      return {
        headline: `Meeting booked with ${lead}`,
        detail: s(p, "scheduled_at") ?? undefined,
        status: "ok",
        source: "Sales-01",
      };
    case "meeting_completed":
      return {
        headline: `Meeting notes captured for ${lead}`,
        detail: s(p, "outcome") ? `Outcome: ${s(p, "outcome")}` : undefined,
        status: "ok",
      };
    case "meeting_no_show":
      return { headline: `${lead}: meeting cancelled / no show`, status: "warn" };

    case "campaign_launched":
      return {
        headline: `Campaign launched: ${s(p, "campaign_name") ?? "unnamed"}`,
        detail: n(p, "enrolled") != null ? `${n(p, "enrolled")} leads enrolled` : undefined,
        status: "ok",
      };
    case "campaign_paused":
      return { headline: `Campaign paused: ${s(p, "campaign_name") ?? "unnamed"}`, status: "warn" };
    case "campaign_completed":
      return { headline: `Campaign completed: ${s(p, "campaign_name") ?? "unnamed"}`, status: "ok" };

    case "note_added":
      return {
        headline: `Note added on ${lead}`,
        detail: s(p, "note") ?? undefined,
        status: "info",
      };

    case "lead_imported":
      if (kind === "manual_create") return { headline: `Lead added: ${company ?? lead}`, status: "info" };
      if (kind === "csv_import") return { headline: `CSV import: ${company ?? lead}`, status: "info" };
      if (kind === "csv_import_summary") {
        return {
          headline: `CSV imported: ${n(p, "inserted") ?? 0} new, ${n(p, "duplicates") ?? 0} duplicates`,
          status: "ok",
        };
      }
      return { headline: `Lead imported`, status: "info" };

    case "quote_sent":
      return { headline: `Quote sent to ${lead}`, status: "ok" };
    case "quote_won":
      return { headline: `${lead}: deal won 🎉`, status: "ok", source: "Close-01" };
    case "quote_lost":
      return { headline: `${lead}: deal lost`, status: "warn" };

    // ── ai_action (the catch-all that needs the most love) ───────
    case "ai_action": {
      switch (kind) {
        case "prospect_run": {
          const found = n(p, "found") ?? n(p, "enriched_with_email") ?? 0;
          const segment = s(p, "segment_name");
          return {
            headline: segment
              ? `Prospect-01 sourced ${found} leads from ${segment}`
              : `Prospect-01 sourced ${found} leads`,
            detail:
              n(p, "duplicates") != null
                ? `${n(p, "duplicates")} duplicates skipped, ${n(p, "new") ?? 0} new`
                : undefined,
            status: "ok",
            source: "Prospect-01",
          };
        }
        case "human_handoff_required":
          return {
            headline: `${lead}: human action required at ${s(p, "stage_name") ?? "next stage"}`,
            status: "warn",
          };
        case "lead_list_approved":
          return {
            headline: `Lead list approved (${n(p, "enrolled") ?? 0} enrolled)`,
            status: "ok",
          };
        case "lead_list_auto_finalised":
          return {
            headline: `Lead batch auto-finalised: ${n(p, "approved_count") ?? 0} approved, ${n(p, "rejected_count") ?? 0} rejected`,
            status: "ok",
          };
        case "approval_rejected":
          return {
            headline: `Approval rejected: ${s(p, "approval_title") ?? "untitled"}`,
            detail: s(p, "reason") ?? undefined,
            status: "warn",
          };
        case "strategy_change_approved":
          return {
            headline: `Strategy change approved`,
            detail: s(p, "summary") ?? undefined,
            status: "ok",
            source: "Learning-01",
          };
        case "playbook_approval_approved":
          return {
            headline: `Playbook went live${client ? ` for ${client}` : ""}`,
            status: "ok",
          };
        case "playbook_submitted":
        case "playbook_branched":
        case "playbook_set_live":
          return {
            headline: kind === "playbook_submitted"
              ? "Playbook submitted for approval"
              : kind === "playbook_branched"
                ? "Playbook branched to a new version"
                : "Playbook set live",
            status: "ok",
          };
        case "icp_translation_refreshed":
          return { headline: `ICP translation refreshed for playbook v${n(p, "version") ?? "?"}`, status: "ok" };
        case "client_sending_unverified":
          return {
            headline: `Send blocked: client domain not verified`,
            detail: s(p, "message") ?? undefined,
            status: "fail",
          };
        case "client_sending_domain_created":
          return { headline: `Sending domain created (${s(p, "domain") ?? "?"})`, status: "ok" };
        case "client_sending_status_changed":
          return { headline: `Sending domain status: ${s(p, "status") ?? "changed"}`, status: "info" };
        case "client_owner_invited":
          return {
            headline: `Client owner invited: ${s(p, "invited_email") ?? "(no email)"}`,
            detail: client ? `for ${client}` : s(p, "client_name") ?? undefined,
            status: "ok",
          };
        case "email_failed":
          return {
            headline: `Email failed to send`,
            detail: s(p, "reason") ?? undefined,
            status: "fail",
          };
        case "email_suppressed":
          return {
            headline: `${s(p, "email") ?? "Email"} added to suppression list`,
            detail: s(p, "reason") ?? undefined,
            status: "warn",
          };
        case "sequence_cancelled":
          return {
            headline: `Sequence cancelled${lead !== "this lead" ? ` for ${lead}` : ""}`,
            detail: s(p, "reason") ?? undefined,
            status: "warn",
          };
        case "stage_condition_gate":
          return {
            headline: `${s(p, "stage_name") ?? "Stage"} condition needs HOS review`,
            detail: s(p, "condition") ?? undefined,
            status: "warn",
          };
        case "onboarding_session_created":
          return {
            headline: `Onboarding interview emailed to client contact`,
            status: "ok",
          };
        case "onboarding_intro_captured":
          return {
            headline: `${s(p, "contact_name") ?? "Contact"} started the onboarding interview`,
            status: "info",
          };
        case "onboarding_answer_recorded":
          return {
            headline: `Interview answer recorded: ${s(p, "topic") ?? "(unknown topic)"}`,
            status: "info",
          };
        case "onboarding_playbook_generated":
          return { headline: `Playbook draft generated from interview`, status: "ok" };
        case "onboarding_feedback_round":
          return {
            headline: `Playbook revised — round ${n(p, "round") ?? 1}`,
            status: "info",
          };
        case "onboarding_section_feedback":
          return {
            headline: `Playbook section "${s(p, "section") ?? "?"}" revised`,
            status: "info",
          };
        case "onboarding_section_approved":
          return {
            headline: `Section approved: ${s(p, "section") ?? "?"}`,
            status: "ok",
          };
        case "onboarding_client_approved":
          return {
            headline: `Client approved their generated playbook`,
            detail: `${n(p, "feedback_rounds") ?? 0} revision rounds`,
            status: "ok",
          };
        case "auto_reply_sent":
          return {
            headline: `Auto-reply sent to ${lead}`,
            detail: s(p, "next_action") ?? undefined,
            status: "ok",
            source: "Sales-01",
          };
        case "weekly_digest_sent":
          return {
            headline: `Weekly digest sent${client ? ` to ${client}` : ""}`,
            status: "ok",
          };
        case "client_created":
          return { headline: `New client added: ${client ?? company ?? "unnamed"}`, status: "ok" };
        case "client_updated":
          return { headline: `Client updated: ${client ?? "unnamed"}`, status: "info" };
        case "lead_deleted":
          return { headline: `Lead deleted: ${lead}`, status: "warn" };
        case "lead_approved_inline":
          return { headline: `Lead approved inline: ${lead}`, status: "ok" };
        case "lead_rejected_inline":
          return { headline: `Lead rejected inline: ${lead}`, status: "warn" };
        case "stripe_payment_succeeded":
          return { headline: `Stripe payment succeeded for ${client ?? "client"}`, status: "ok" };
        case "stripe_payment_failed":
          return { headline: `Stripe payment failed for ${client ?? "client"}`, status: "fail" };
        case "stripe_subscription_cancelled":
        case "subscription_paused":
          return {
            headline: `Subscription ${kind === "subscription_paused" ? "paused" : "cancelled"}${client ? ` (${client})` : ""}`,
            status: "warn",
          };
        case "learning_run":
          return { headline: `Learning-01 ran nightly analysis`, status: "ok", source: "Learning-01" };
        default:
          return {
            headline: prettifyKind(kind) || `Agent action${lead !== "this lead" ? ` on ${lead}` : ""}`,
            detail: s(p, "message") ?? undefined,
            status: "info",
          };
      }
    }

    case "query_run":
      return {
        headline: `Query run: ${s(p, "question") ?? "(no question)"}`,
        status: "info",
      };

    default:
      return FALLBACK;
  }
}

/** Best-effort prettifier for unknown `kind` values — "foo_bar" → "Foo bar". */
function prettifyKind(kind: string): string {
  if (!kind) return "";
  return kind.replace(/_/g, " ").replace(/\b\w/, (c) => c.toUpperCase());
}
