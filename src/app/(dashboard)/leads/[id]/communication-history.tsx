import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { formatDateTime } from "@/lib/utils";
import {
  ArrowLeftCircle,
  ArrowRightCircle,
  CalendarDays,
  CheckCircle2,
  ClipboardList,
  Eye,
  FileText,
  MessageCircle,
  StickyNote,
  Workflow,
  type LucideIcon,
} from "lucide-react";
import type { AppEvent, Email, Meeting, MeetingNote } from "@/lib/supabase/types";

/**
 * Unified Communication History — single chronological feed combining
 * outbound + inbound emails, replies, meeting bookings, captured meeting
 * notes, sales-process stage changes (with agent attribution), and
 * internal notes. Each row shows type · preview · timestamp · who.
 *
 * Renders the "Email history" panel from the previous design, expanded.
 */
type Item = {
  ts: string; // ISO
  type:
    | "email_outbound"
    | "email_inbound"
    | "email_opened"
    | "email_replied"
    | "email_bounced"
    | "meeting_scheduled"
    | "meeting_notes"
    | "stage_change"
    | "human_handoff"
    | "note"
    | "approval"
    | "ai_action"
    | "other";
  title: string;
  preview?: string | null;
  who?: string | null; // agent handle or person name
  href?: string | null;
};

export function CommunicationHistory({
  emails = [],
  events = [],
  meetings = [],
  meetingNotes = [],
}: {
  emails?: Email[];
  events?: AppEvent[];
  meetings?: Meeting[];
  meetingNotes?: MeetingNote[];
}) {
  const items: Item[] = [];

  // Emails — split per signal so the timeline reads chronologically
  for (const e of emails) {
    const subj = e.subject ?? "(no subject)";
    const stepLabel = e.step_number != null ? ` · step ${e.step_number}` : "";

    if (e.direction === "outbound") {
      const sentTs = e.sent_at ?? e.created_at;
      items.push({
        ts: sentTs,
        type: e.status === "bounced" ? "email_bounced" : "email_outbound",
        title:
          e.status === "pending"
            ? `Outbound queued${stepLabel}`
            : e.status === "bounced"
            ? `Outbound bounced${stepLabel}`
            : `Outbound sent${stepLabel}`,
        preview: subj,
        who: "outreach-01",
      });
      if (e.opened_at) {
        items.push({
          ts: e.opened_at,
          type: "email_opened",
          title: `Lead opened the email${stepLabel}`,
          preview: subj,
        });
      }
      if (e.replied_at || e.reply_body) {
        items.push({
          ts: e.replied_at ?? sentTs,
          type: "email_replied",
          title: `Lead replied${stepLabel}`,
          preview: e.reply_body ?? subj,
        });
      }
    } else {
      // inbound row recorded directly (e.g. raw inbound email)
      items.push({
        ts: e.replied_at ?? e.created_at,
        type: "email_inbound",
        title: subj,
        preview: e.body ?? e.reply_body ?? null,
      });
    }
  }

  // Meeting bookings
  for (const m of meetings) {
    items.push({
      ts: m.scheduled_at ?? m.created_at,
      type: "meeting_scheduled",
      title: `Meeting ${m.status}`,
      preview: m.notes ?? `${m.format} meeting · ${m.duration_minutes} min`,
      who: "scheduler-01",
    });
  }

  // Captured post-meeting notes
  for (const n of meetingNotes) {
    items.push({
      ts: n.created_at,
      type: "meeting_notes",
      title: `Meeting outcome: ${n.outcome.replace("_", " ")}`,
      preview: n.next_steps ?? n.notes ?? n.objections ?? null,
      who: "human-rep",
    });
  }

  // Events — pick the ones worth showing in the feed
  for (const e of events) {
    const payload = (e.payload ?? {}) as Record<string, unknown>;
    const kind = typeof payload.kind === "string" ? payload.kind : null;

    if (e.event_type === "stage_changed") {
      const before = stringValue(payload.before);
      const after = stringValue(payload.after) ?? stringValue(payload.next_stage_id);
      const stageName = stringValue(payload.stage_name) ?? stringValue(payload.completed_stage_name);
      items.push({
        ts: e.created_at,
        type: "stage_change",
        title:
          stageName
            ? `Stage moved → ${stageName}`
            : after
            ? `Stage moved${before ? ` from ${before}` : ""} → ${after}`
            : "Stage moved",
        preview: stringValue(payload.message) ?? null,
        who: stringValue(payload.next_stage_agent) ?? "system",
      });
      continue;
    }

    if (e.event_type === "note_added") {
      items.push({
        ts: e.created_at,
        type: "note",
        title: "Internal note",
        preview: stringValue(payload.note) ?? null,
        who: stringValue(payload.user_name) ?? "hos",
      });
      continue;
    }

    if (e.event_type === "ai_action" && kind === "human_handoff_required") {
      items.push({
        ts: e.created_at,
        type: "human_handoff",
        title: `Handoff to human: ${stringValue(payload.stage_name) ?? "stage"}`,
        preview: stringValue(payload.message) ?? null,
        who: "system",
      });
      continue;
    }

    if (e.event_type === "ai_action" && (kind === "lead_approved_inline" || kind === "lead_rejected_inline" || kind === "lead_list_auto_finalised")) {
      items.push({
        ts: e.created_at,
        type: "approval",
        title:
          kind === "lead_approved_inline"
            ? "Lead approved"
            : kind === "lead_rejected_inline"
            ? "Lead rejected"
            : "Lead-list auto-finalised",
        preview: null,
        who: "hos",
      });
      continue;
    }

    if (e.event_type === "email_sent" || e.event_type === "email_opened" || e.event_type === "email_replied" || e.event_type === "email_bounced") {
      // Already covered by emails[] above
      continue;
    }

    if (e.event_type === "ai_action") {
      items.push({
        ts: e.created_at,
        type: "ai_action",
        title: `Agent action: ${kind ?? e.event_type}`,
        preview: stringValue(payload.message) ?? null,
        who: typeof payload.agent === "string" ? payload.agent : null,
      });
    }
  }

  // Sort newest → oldest
  items.sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0));

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Communication history ({items.length})</CardTitle>
      </CardHeader>
      <CardContent>
        {items.length === 0 ? (
          <p className="text-sm text-muted-foreground">Nothing yet — the feed populates as agents act.</p>
        ) : (
          <ul className="space-y-3">
            {items.map((it, i) => {
              const { Icon, klass } = visualFor(it.type);
              return (
                <li key={i} className="flex gap-3">
                  <div className={`mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full ${klass}`}>
                    <Icon className="h-3.5 w-3.5" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-baseline justify-between gap-2">
                      <p className="text-sm font-medium">{it.title}</p>
                      <span className="shrink-0 text-xs text-muted-foreground">{formatDateTime(it.ts)}</span>
                    </div>
                    {it.preview && (
                      <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">{it.preview}</p>
                    )}
                    {it.who && (
                      <Badge variant="muted" className="mt-1 text-[10px]">
                        {it.who}
                      </Badge>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

function stringValue(v: unknown): string | null {
  if (typeof v === "string") return v;
  if (typeof v === "number") return String(v);
  return null;
}

function visualFor(t: Item["type"]): { Icon: LucideIcon; klass: string } {
  switch (t) {
    case "email_outbound":
      return { Icon: ArrowRightCircle, klass: "bg-emerald-100 text-emerald-700" };
    case "email_inbound":
    case "email_replied":
      return { Icon: ArrowLeftCircle, klass: "bg-blue-100 text-blue-700" };
    case "email_opened":
      return { Icon: Eye, klass: "bg-amber-100 text-amber-700" };
    case "email_bounced":
      return { Icon: MessageCircle, klass: "bg-rose-100 text-rose-700" };
    case "meeting_scheduled":
      return { Icon: CalendarDays, klass: "bg-purple-100 text-purple-700" };
    case "meeting_notes":
      return { Icon: ClipboardList, klass: "bg-emerald-100 text-emerald-700" };
    case "stage_change":
      return { Icon: Workflow, klass: "bg-indigo-100 text-indigo-700" };
    case "human_handoff":
      return { Icon: Workflow, klass: "bg-amber-100 text-amber-800" };
    case "note":
      return { Icon: StickyNote, klass: "bg-yellow-100 text-yellow-800" };
    case "approval":
      return { Icon: CheckCircle2, klass: "bg-emerald-100 text-emerald-700" };
    case "ai_action":
      return { Icon: FileText, klass: "bg-slate-100 text-slate-700" };
    default:
      return { Icon: FileText, klass: "bg-muted text-muted-foreground" };
  }
}
