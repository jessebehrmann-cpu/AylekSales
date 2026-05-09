import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { formatDateTime } from "@/lib/utils";
import {
  ArrowLeftCircle,
  ArrowRightCircle,
  CalendarDays,
  ClipboardList,
  Eye,
  FileText,
  MessageCircle,
  Send,
  Workflow,
  type LucideIcon,
} from "lucide-react";
import { labelForAgent } from "@/lib/playbook-defaults";
import type {
  AppEvent,
  Approval,
  Email,
  Meeting,
  MeetingNote,
  ProposalReviewPayload,
} from "@/lib/supabase/types";

/**
 * Communication history — 4 grouped sections that read like a deal timeline:
 *   1. Outreach        — emails sent + replies + opens + bounces
 *   2. Meetings        — meeting bookings + captured meeting notes
 *   3. Proposals       — proposal_review approvals (drafts awaiting send)
 *   4. Stage changes   — process-stage advancements with agent attribution
 *
 * Inside each section, items are oldest → newest top to bottom (so the deal
 * reads as a story). Plain-English labels — no `stage_changed` in the UI.
 */

type Item = {
  ts: string;
  title: string;
  preview?: string | null;
  icon: LucideIcon;
  iconClass: string;
  who?: string | null;
};

export function CommunicationHistory({
  emails = [],
  events = [],
  meetings = [],
  meetingNotes = [],
  proposalApprovals = [],
}: {
  emails?: Email[];
  events?: AppEvent[];
  meetings?: Meeting[];
  meetingNotes?: MeetingNote[];
  proposalApprovals?: Approval[];
}) {
  const outreach: Item[] = [];
  const meetingItems: Item[] = [];
  const proposalItems: Item[] = [];
  const stageItems: Item[] = [];

  // ── Outreach ────────────────────────────────────────────────────────────
  for (const e of emails) {
    const subj = e.subject ?? "(no subject)";
    const stepLabel = e.step_number != null ? ` · step ${e.step_number}` : "";

    if (e.direction === "outbound") {
      const sentTs = e.sent_at ?? e.created_at;
      const sender = "Outreach-01";
      let title: string;
      let icon: LucideIcon = ArrowRightCircle;
      let iconClass = "bg-emerald-100 text-emerald-700";
      switch (e.status) {
        case "pending":
          title = `${sender} queued an email${stepLabel}`;
          break;
        case "bounced":
          title = `Email bounced${stepLabel}`;
          icon = MessageCircle;
          iconClass = "bg-rose-100 text-rose-700";
          break;
        case "failed":
          title = `Send failed${stepLabel}`;
          icon = MessageCircle;
          iconClass = "bg-rose-100 text-rose-700";
          break;
        default:
          title = `${sender} sent an email${stepLabel}`;
      }
      outreach.push({ ts: sentTs, title, preview: subj, icon, iconClass, who: sender });
      if (e.opened_at) {
        outreach.push({
          ts: e.opened_at,
          title: `Lead opened the message${stepLabel}`,
          preview: subj,
          icon: Eye,
          iconClass: "bg-amber-100 text-amber-700",
        });
      }
      if (e.replied_at || e.reply_body) {
        outreach.push({
          ts: e.replied_at ?? sentTs,
          title: `Lead replied${stepLabel}`,
          preview: e.reply_body ?? subj,
          icon: ArrowLeftCircle,
          iconClass: "bg-blue-100 text-blue-700",
          who: "Lead",
        });
      }
    } else {
      // inbound row recorded directly (raw inbound email)
      outreach.push({
        ts: e.replied_at ?? e.created_at,
        title: "Lead sent an inbound email",
        preview: e.body ?? e.reply_body ?? subj,
        icon: ArrowLeftCircle,
        iconClass: "bg-blue-100 text-blue-700",
        who: "Lead",
      });
    }
  }

  // ── Meetings ────────────────────────────────────────────────────────────
  for (const m of meetings) {
    meetingItems.push({
      ts: m.scheduled_at ?? m.created_at,
      title: `Meeting ${m.status === "scheduled" ? "booked" : m.status}`,
      preview: m.notes ?? `${m.format} · ${m.duration_minutes} min`,
      icon: CalendarDays,
      iconClass: "bg-purple-100 text-purple-700",
      who: "Sales-01",
    });
  }
  for (const n of meetingNotes) {
    meetingItems.push({
      ts: n.created_at,
      title: `Meeting outcome: ${prettyOutcome(n.outcome)}`,
      preview:
        n.next_steps ?? n.notes ?? n.objections ?? "(no notes captured)",
      icon: ClipboardList,
      iconClass: "bg-emerald-100 text-emerald-700",
      who: "HOS",
    });
  }

  // ── Proposals ───────────────────────────────────────────────────────────
  for (const a of proposalApprovals) {
    const payload = (a.payload ?? {}) as Partial<ProposalReviewPayload>;
    const status =
      a.status === "approved"
        ? "sent"
        : a.status === "rejected"
        ? "rejected"
        : "pending HOS review";
    proposalItems.push({
      ts: a.created_at,
      title: `Sales-01 drafted a proposal — ${status}`,
      preview: payload.drafted_subject ?? "(subject pending)",
      icon: Send,
      iconClass: "bg-emerald-100 text-emerald-700",
      who: "Sales-01",
    });
  }

  // ── Stage changes ───────────────────────────────────────────────────────
  for (const e of events) {
    const payload = (e.payload ?? {}) as Record<string, unknown>;
    const kind = stringValue(payload.kind);

    if (e.event_type === "stage_changed") {
      const stageName =
        stringValue(payload.stage_name) ??
        stringValue(payload.completed_stage_name);
      const after =
        stageName ??
        stringValue(payload.next_stage_id) ??
        stringValue(payload.after) ??
        "next stage";
      const before = stringValue(payload.before) ?? null;
      const movedBy = stringValue(payload.next_stage_agent) ?? stringValue(payload.agent) ?? "system";
      const moverLabel = labelForAgent(movedBy);

      let title: string;
      if (kind === "human_stage_completed") {
        title = `HOS marked "${stringValue(payload.completed_stage_name) ?? "the stage"}" complete — advanced to ${after}`;
      } else if (kind === "process_stage_moved") {
        title = `${moverLabel} moved this lead to ${after}`;
      } else if (kind === "unsubscribed_via_button") {
        title = "Lead marked unsubscribed";
      } else if (kind === "manual_stage_update") {
        title = `Lead stage updated → ${after}`;
      } else {
        title = `Moved to ${after}${before ? ` (was ${before})` : ""}`;
      }

      stageItems.push({
        ts: e.created_at,
        title,
        preview: stringValue(payload.message) ?? null,
        icon: Workflow,
        iconClass: "bg-indigo-100 text-indigo-700",
        who: moverLabel,
      });
      continue;
    }

    if (e.event_type === "ai_action" && kind === "human_handoff_required") {
      stageItems.push({
        ts: e.created_at,
        title: `Handed off to a human at "${stringValue(payload.stage_name) ?? "stage"}"`,
        preview: stringValue(payload.message) ?? null,
        icon: Workflow,
        iconClass: "bg-amber-100 text-amber-800",
        who: "system",
      });
      continue;
    }

    if (e.event_type === "note_added") {
      stageItems.push({
        ts: e.created_at,
        title: "HOS added an internal note",
        preview: stringValue(payload.note) ?? null,
        icon: FileText,
        iconClass: "bg-yellow-100 text-yellow-800",
        who: "HOS",
      });
    }
  }

  // Sort each group oldest → newest so the deal reads as a story
  outreach.sort(byOldestFirst);
  meetingItems.sort(byOldestFirst);
  proposalItems.sort(byOldestFirst);
  stageItems.sort(byOldestFirst);

  const totalCount =
    outreach.length + meetingItems.length + proposalItems.length + stageItems.length;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Communication history ({totalCount})</CardTitle>
      </CardHeader>
      <CardContent className="space-y-6">
        <Section title="Outreach" empty="No emails yet." items={outreach} />
        <Section title="Meetings" empty="No meetings or meeting notes yet." items={meetingItems} />
        <Section title="Proposals" empty="No drafted proposals yet." items={proposalItems} />
        <Section title="Stage changes" empty="Stage changes will appear here as the lead moves through the pipeline." items={stageItems} />
      </CardContent>
    </Card>
  );
}

function Section({ title, items, empty }: { title: string; items: Item[]; empty: string }) {
  return (
    <div>
      <p className="mb-2 text-[10px] font-semibold uppercase tracking-[0.15em] text-muted-foreground">
        {title}
      </p>
      {items.length === 0 ? (
        <p className="text-sm text-muted-foreground">{empty}</p>
      ) : (
        <ul className="space-y-3">
          {items.map((it, i) => {
            const Icon = it.icon;
            return (
              <li key={i} className="flex gap-3">
                <div className={`mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full ${it.iconClass}`}>
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
    </div>
  );
}

function byOldestFirst(a: Item, b: Item): number {
  return a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0;
}

function stringValue(v: unknown): string | null {
  if (typeof v === "string") return v;
  if (typeof v === "number") return String(v);
  return null;
}

function prettyOutcome(o: string): string {
  switch (o) {
    case "positive":
      return "positive — strong interest";
    case "neutral":
      return "neutral — needs more info";
    case "negative":
      return "negative — not a fit";
    case "no_show":
      return "no show";
    default:
      return o;
  }
}
