import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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
  SalesProcessStage,
} from "@/lib/supabase/types";

/**
 * Communication history — a single chronological timeline of every signal
 * tied to this lead, oldest → newest, with the active sales-process stage
 * as a small grey milestone label above each entry.
 *
 * Stage at time T is reconstructed by walking the lead's `stage_changed`
 * events in order — items emitted before any stage_changed default to the
 * playbook's first stage (typically Prospect).
 *
 * Plain-English labels everywhere — never raw event_type strings.
 */

type Item = {
  ts: string;
  /** Sales-process stage id active at this moment in the deal. Used to
   *  derive the [Stage] label printed above each entry. */
  stageId: string | null;
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
  stages = [],
}: {
  emails?: Email[];
  events?: AppEvent[];
  meetings?: Meeting[];
  meetingNotes?: MeetingNote[];
  proposalApprovals?: Approval[];
  stages?: SalesProcessStage[];
}) {
  // ── 1. Reconstruct stage history from stage_changed events ──────────────
  // Each entry: at this timestamp, the lead is now at this stage_id.
  type StageMark = { ts: string; stageId: string };
  const stageHistory: StageMark[] = [];
  for (const e of events) {
    if (e.event_type !== "stage_changed") continue;
    const payload = (e.payload ?? {}) as Record<string, unknown>;
    const next =
      stringValue(payload.next_stage_id) ??
      stringValue(payload.after) ??
      stringValue(payload.stage_id) ??
      null;
    if (next) stageHistory.push({ ts: e.created_at, stageId: next });
  }
  stageHistory.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));

  // The default stage before any stage_change has happened — first stage in
  // the playbook (typically "Prospect").
  const firstStageId = stages[0]?.id ?? null;
  function stageAt(ts: string): string | null {
    let cur = firstStageId;
    for (const m of stageHistory) {
      if (m.ts <= ts) cur = m.stageId;
      else break;
    }
    return cur;
  }
  const stageNameById = new Map(stages.map((s) => [s.id, s.name] as const));

  // ── 2. Build items from each source ─────────────────────────────────────
  const items: Item[] = [];

  // Emails
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
          title = `${sender} sent email: "${subj}"${stepLabel}`;
      }
      items.push({ ts: sentTs, stageId: null, title, preview: subj, icon, iconClass, who: sender });
      if (e.opened_at) {
        items.push({
          ts: e.opened_at,
          stageId: null,
          title: `Lead opened the message${stepLabel}`,
          preview: subj,
          icon: Eye,
          iconClass: "bg-amber-100 text-amber-700",
        });
      }
      if (e.replied_at || e.reply_body) {
        items.push({
          ts: e.replied_at ?? sentTs,
          stageId: null,
          title: `Lead replied${stepLabel}`,
          preview: e.reply_body ?? subj,
          icon: ArrowLeftCircle,
          iconClass: "bg-blue-100 text-blue-700",
          who: "Lead",
        });
      }
    } else {
      items.push({
        ts: e.replied_at ?? e.created_at,
        stageId: null,
        title: "Lead sent an inbound email",
        preview: e.body ?? e.reply_body ?? subj,
        icon: ArrowLeftCircle,
        iconClass: "bg-blue-100 text-blue-700",
        who: "Lead",
      });
    }
  }

  // Meetings (bookings)
  for (const m of meetings) {
    items.push({
      ts: m.scheduled_at ?? m.created_at,
      stageId: null,
      title: `Meeting ${m.status === "scheduled" ? "booked" : m.status}`,
      preview: m.notes ?? `${m.format} · ${m.duration_minutes} min`,
      icon: CalendarDays,
      iconClass: "bg-purple-100 text-purple-700",
      who: "Sales-01",
    });
  }

  // Meeting notes (post-meeting captures)
  for (const n of meetingNotes) {
    items.push({
      ts: n.created_at,
      stageId: null,
      title: `HOS marked meeting complete: ${prettyOutcome(n.outcome)}`,
      preview: n.next_steps ?? n.notes ?? n.objections ?? "(no notes captured)",
      icon: ClipboardList,
      iconClass: "bg-emerald-100 text-emerald-700",
      who: "HOS",
    });
  }

  // Proposal review approvals (drafts + sent)
  for (const a of proposalApprovals) {
    const payload = (a.payload ?? {}) as Partial<ProposalReviewPayload>;
    const status =
      a.status === "approved"
        ? "sent to lead"
        : a.status === "rejected"
        ? "rejected by HOS"
        : "pending HOS review";
    items.push({
      ts: a.created_at,
      stageId: null,
      title: `Sales-01 drafted proposal — ${status}`,
      preview: payload.drafted_subject ?? "(subject pending)",
      icon: Send,
      iconClass: "bg-emerald-100 text-emerald-700",
      who: "Sales-01",
    });
  }

  // Events — stage changes, notes, handoffs
  for (const e of events) {
    const payload = (e.payload ?? {}) as Record<string, unknown>;
    const kind = stringValue(payload.kind);

    if (e.event_type === "stage_changed") {
      const stageName =
        stringValue(payload.stage_name) ??
        stringValue(payload.completed_stage_name);
      const after =
        stageName ??
        prettyStageId(stringValue(payload.next_stage_id), stageNameById) ??
        prettyStageId(stringValue(payload.after), stageNameById) ??
        "next stage";
      const movedBy =
        stringValue(payload.next_stage_agent) ??
        stringValue(payload.agent) ??
        "system";
      const moverLabel = labelForAgent(movedBy);

      let title: string;
      if (kind === "human_stage_completed") {
        const completed = stringValue(payload.completed_stage_name) ?? "the stage";
        title = `HOS marked "${completed}" complete — advanced to ${after}`;
      } else if (kind === "process_stage_moved") {
        title = `${moverLabel} moved this lead to ${after}`;
      } else if (kind === "unsubscribed_via_button") {
        title = "Lead marked unsubscribed";
      } else if (kind === "manual_stage_update") {
        title = `Lead stage updated → ${after}`;
      } else {
        title = `Moved to ${after}`;
      }

      items.push({
        ts: e.created_at,
        stageId: null,
        title,
        preview: stringValue(payload.message) ?? null,
        icon: Workflow,
        iconClass: "bg-indigo-100 text-indigo-700",
        who: moverLabel,
      });
      continue;
    }

    if (e.event_type === "ai_action" && kind === "human_handoff_required") {
      items.push({
        ts: e.created_at,
        stageId: null,
        title: `Handed off to a human at "${stringValue(payload.stage_name) ?? "stage"}"`,
        preview: stringValue(payload.message) ?? null,
        icon: Workflow,
        iconClass: "bg-amber-100 text-amber-800",
        who: "system",
      });
      continue;
    }

    if (e.event_type === "ai_action" && kind === "prospect_run") {
      items.push({
        ts: e.created_at,
        stageId: null,
        title: `Prospect-01 sourced this lead`,
        preview: null,
        icon: ArrowRightCircle,
        iconClass: "bg-emerald-100 text-emerald-700",
        who: "Prospect-01",
      });
      continue;
    }

    if (e.event_type === "lead_imported") {
      items.push({
        ts: e.created_at,
        stageId: null,
        title: "Lead added",
        preview: null,
        icon: ArrowRightCircle,
        iconClass: "bg-slate-100 text-slate-700",
        who: stringValue(payload.kind) === "csv_import" ? "HOS (CSV import)" : "HOS",
      });
      continue;
    }

    if (e.event_type === "note_added") {
      items.push({
        ts: e.created_at,
        stageId: null,
        title: "HOS added an internal note",
        preview: stringValue(payload.note) ?? null,
        icon: FileText,
        iconClass: "bg-yellow-100 text-yellow-800",
        who: "HOS",
      });
    }
  }

  // ── 3. Sort + assign stage labels ───────────────────────────────────────
  items.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
  for (const it of items) {
    it.stageId = stageAt(it.ts);
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Communication history ({items.length})</CardTitle>
      </CardHeader>
      <CardContent>
        {items.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Nothing yet — the timeline populates as agents act and the lead moves through the pipeline.
          </p>
        ) : (
          <ol className="relative ml-3 space-y-4 border-l border-border pl-6">
            {items.map((it, i) => {
              const prev = i > 0 ? items[i - 1] : null;
              const stageChanged =
                !prev || prev.stageId !== it.stageId;
              const stageName =
                (it.stageId && stageNameById.get(it.stageId)) ?? it.stageId ?? null;
              const Icon = it.icon;
              return (
                <li key={i} className="relative">
                  {stageChanged && stageName && (
                    <p className="-ml-9 mb-2 inline-block rounded-md bg-muted px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.15em] text-muted-foreground">
                      {stageName} stage
                    </p>
                  )}
                  <span
                    className={`absolute -left-[34px] flex h-6 w-6 items-center justify-center rounded-full border-2 border-background ${it.iconClass}`}
                  >
                    <Icon className="h-3 w-3" />
                  </span>
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <p className="text-sm font-medium">{it.title}</p>
                    <span className="shrink-0 text-xs text-muted-foreground">
                      {it.who ? `${it.who} · ` : ""}
                      {formatDateTime(it.ts)}
                    </span>
                  </div>
                  {it.preview && (
                    <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">{it.preview}</p>
                  )}
                </li>
              );
            })}
          </ol>
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

function prettyStageId(id: string | null, byId: Map<string, string>): string | null {
  if (!id) return null;
  return byId.get(id) ?? id;
}
