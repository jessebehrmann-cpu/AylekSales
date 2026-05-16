"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Alert } from "@/components/ui/alert";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Check,
  X,
  Search,
  RefreshCw,
  Plus,
  ExternalLink,
  Hand,
  Mail,
  ChevronDown,
  ChevronUp,
  BookOpen,
} from "lucide-react";
import {
  approveApproval,
  approveProposalReview,
  approveReplyReview,
  rejectApproval,
} from "./actions";
import type {
  Approval,
  HumanStageTaskPayload,
  LeadListPayload,
  PlaybookApprovalPayload,
  ProposalReviewPayload,
  ReplyReviewPayload,
  StrategyChangePayload,
} from "@/lib/supabase/types";
import { formatDateTime } from "@/lib/utils";

type ApprovalRow = Approval & { clients: { name: string } | null };
type CampaignOption = { id: string; name: string; status: string; client_id: string | null };
type BatchLead = { id: string; company_name: string; contact_name: string | null };

const NEW_CAMPAIGN_VALUE = "__new__";

export function ApprovalCard({
  approval,
  clientCampaigns = [],
  batchLeads = [],
}: {
  approval: ApprovalRow;
  clientCampaigns?: CampaignOption[];
  batchLeads?: BatchLead[];
}) {
  const isPending = approval.status === "pending";

  return (
    <Card className={isPending ? "border-amber-200 bg-amber-50/30" : undefined}>
      <CardContent className="pt-6">
        <ApprovalHeader approval={approval} />

        {approval.type === "lead_list" && (
          <LeadListBody
            approval={approval}
            isPending={isPending}
            clientCampaigns={clientCampaigns}
            batchLeads={batchLeads}
          />
        )}
        {approval.type === "strategy_change" && (
          <StrategyChangeBody approval={approval} isPending={isPending} />
        )}
        {approval.type === "human_stage_task" && (
          <HumanStageTaskBody approval={approval} isPending={isPending} />
        )}
        {approval.type === "proposal_review" && (
          <ProposalReviewBody approval={approval} isPending={isPending} />
        )}
        {approval.type === "playbook_approval" && (
          <PlaybookApprovalBody approval={approval} isPending={isPending} />
        )}
        {approval.type === "reply_review" && (
          <ReplyReviewBody approval={approval} isPending={isPending} />
        )}

        {!isPending && approval.decided_at && (
          <p className="mt-3 text-xs text-muted-foreground">
            Decided {formatDateTime(approval.decided_at)}
          </p>
        )}
      </CardContent>
    </Card>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// Header (icon + title + type label + status badge)
// ──────────────────────────────────────────────────────────────────────────

function ApprovalHeader({ approval }: { approval: ApprovalRow }) {
  const meta = headerMetaFor(approval.type);
  const Icon = meta.icon;
  return (
    <div className="mb-3 flex items-start gap-3">
      <div className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-lg ${meta.iconBg}`}>
        <Icon className="h-5 w-5" />
      </div>
      <div className="flex-1 min-w-0">
        <p className="font-semibold">{approval.title}</p>
        <p className="mt-0.5 text-xs text-muted-foreground">
          {approval.clients?.name ? `${approval.clients.name} · ` : ""}
          {meta.label} · {formatDateTime(approval.created_at)}
        </p>
      </div>
      <Badge variant={statusVariant(approval.status)}>{approval.status}</Badge>
    </div>
  );
}

function headerMetaFor(type: Approval["type"]) {
  switch (type) {
    case "lead_list":
      return { label: "Lead list", icon: Search, iconBg: "bg-emerald-100 text-emerald-700" };
    case "strategy_change":
      return { label: "Strategy change", icon: RefreshCw, iconBg: "bg-purple-100 text-purple-700" };
    case "human_stage_task":
      return { label: "Human action required", icon: Hand, iconBg: "bg-amber-100 text-amber-800" };
    case "proposal_review":
      return { label: "Proposal review", icon: Mail, iconBg: "bg-emerald-100 text-emerald-700" };
    case "playbook_approval":
      return {
        label: "Playbook final review",
        icon: BookOpen,
        iconBg: "bg-violet-100 text-violet-700",
      };
    case "reply_review":
      return { label: "Reply review", icon: Mail, iconBg: "bg-blue-100 text-blue-700" };
    default:
      return { label: String(type), icon: Search, iconBg: "bg-muted text-muted-foreground" };
  }
}

function statusVariant(status: Approval["status"]) {
  switch (status) {
    case "approved":
      return "success" as const;
    case "rejected":
      return "destructive" as const;
    default:
      return "warning" as const;
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Type-specific bodies
// ──────────────────────────────────────────────────────────────────────────

function LeadListBody({
  approval,
  isPending,
  clientCampaigns,
  batchLeads,
}: {
  approval: ApprovalRow;
  isPending: boolean;
  clientCampaigns: CampaignOption[];
  batchLeads: BatchLead[];
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const payload = approval.payload as LeadListPayload;
  const total = payload.lead_ids?.length ?? 0;
  const preview = batchLeads.slice(0, 6);
  const remaining = total - preview.length;

  const payloadCampaignId = payload.campaign_id ?? null;
  const needsCampaignChoice = !payloadCampaignId;
  const initialChoice =
    payloadCampaignId ?? clientCampaigns[0]?.id ?? (needsCampaignChoice ? NEW_CAMPAIGN_VALUE : "");
  const [campaignChoice, setCampaignChoice] = useState<string>(initialChoice);
  const [newCampaignName, setNewCampaignName] = useState<string>("");

  function onApprove() {
    setError(null);
    type ApproveBody = {
      id: string;
      campaign_id?: string;
      new_campaign?: { name: string };
    };
    const body: ApproveBody = { id: approval.id };
    if (needsCampaignChoice) {
      if (campaignChoice === NEW_CAMPAIGN_VALUE) {
        if (!newCampaignName.trim()) {
          setError("Name the new campaign before approving.");
          return;
        }
        body.new_campaign = { name: newCampaignName.trim() };
      } else if (campaignChoice) {
        body.campaign_id = campaignChoice;
      } else {
        setError("Pick a campaign for these leads.");
        return;
      }
    }
    if (!confirm("Approve and start outreach?")) return;
    start(async () => {
      const r = await approveApproval(body);
      if (!r.ok) {
        setError(r.error);
        return;
      }
      router.refresh();
    });
  }

  function onReject() {
    setError(null);
    if (!confirm("Reject this approval?")) return;
    start(async () => {
      const r = await rejectApproval({ id: approval.id });
      if (!r.ok) {
        setError(r.error);
        return;
      }
      router.refresh();
    });
  }

  return (
    <>
      {approval.summary && (
        <p className="mb-3 rounded-md bg-muted px-3 py-2 text-sm text-muted-foreground">
          {approval.summary}
        </p>
      )}
      <div className="space-y-2 text-xs text-muted-foreground">
        <p>
          <span className="font-medium text-foreground">{total}</span> lead{total === 1 ? "" : "s"} in this batch
          {payload.source && ` · sourced from ${payload.source}`}
        </p>
        {preview.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {preview.map((l) => (
              <Link
                key={l.id}
                href={`/leads/${l.id}`}
                className="rounded-md border border-border bg-background px-2 py-0.5 text-xs font-medium text-foreground hover:bg-muted"
              >
                {l.company_name}
              </Link>
            ))}
            {remaining > 0 && (
              <span className="rounded-md border border-dashed border-border px-2 py-0.5 text-xs">
                + {remaining} more
              </span>
            )}
          </div>
        )}
        <Link
          href={`/leads?approval=${approval.id}`}
          className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline"
        >
          View all leads in this batch <ExternalLink className="h-3 w-3" />
        </Link>
      </div>

      {isPending && needsCampaignChoice && (
        <div className="mt-4 space-y-3 rounded-lg border border-amber-200 bg-amber-50/40 p-3">
          <div className="space-y-1.5">
            <Label htmlFor={`campaign-${approval.id}`} className="text-xs uppercase tracking-wider">
              Send these leads to
            </Label>
            <Select value={campaignChoice} onValueChange={setCampaignChoice}>
              <SelectTrigger id={`campaign-${approval.id}`}>
                <SelectValue placeholder="Pick a campaign…" />
              </SelectTrigger>
              <SelectContent>
                {clientCampaigns.map((c) => (
                  <SelectItem key={c.id} value={c.id}>
                    {c.name} <span className="ml-1 text-xs text-muted-foreground">· {c.status}</span>
                  </SelectItem>
                ))}
                <SelectItem value={NEW_CAMPAIGN_VALUE}>+ Create a new campaign</SelectItem>
              </SelectContent>
            </Select>
          </div>
          {campaignChoice === NEW_CAMPAIGN_VALUE && (
            <div className="space-y-1.5">
              <Label htmlFor={`new-name-${approval.id}`} className="flex items-center gap-1 text-xs uppercase tracking-wider">
                <Plus className="h-3 w-3" /> New campaign name
              </Label>
              <Input
                id={`new-name-${approval.id}`}
                value={newCampaignName}
                onChange={(e) => setNewCampaignName(e.target.value)}
                placeholder="e.g. Q3 Outbound — APAC"
              />
            </div>
          )}
        </div>
      )}

      {error && <Alert variant="destructive" className="mt-3">{error}</Alert>}

      {isPending && (
        <div className="mt-4 flex gap-2">
          <Button onClick={onApprove} disabled={pending} size="sm">
            <Check className="mr-1.5 h-3 w-3" /> Approve · Start outreach
          </Button>
          <Button variant="outline" onClick={onReject} disabled={pending} size="sm">
            <X className="mr-1.5 h-3 w-3" /> Reject
          </Button>
        </div>
      )}
    </>
  );
}

function StrategyChangeBody({ approval, isPending }: { approval: ApprovalRow; isPending: boolean }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const p = approval.payload as StrategyChangePayload & { mode?: string; version?: number };

  function onApprove() {
    setError(null);
    if (!confirm("Approve this strategy change?")) return;
    start(async () => {
      const r = await approveApproval({ id: approval.id });
      if (!r.ok) {
        setError(r.error);
        return;
      }
      router.refresh();
    });
  }
  function onReject() {
    setError(null);
    if (!confirm("Reject this approval?")) return;
    start(async () => {
      const r = await rejectApproval({ id: approval.id });
      if (!r.ok) {
        setError(r.error);
        return;
      }
      router.refresh();
    });
  }

  return (
    <>
      {approval.summary && (
        <p className="mb-3 rounded-md bg-muted px-3 py-2 text-sm text-muted-foreground">
          {approval.summary}
        </p>
      )}
      {p.mode === "promote_draft" ? (
        <p className="text-xs text-muted-foreground">
          Promotes the draft playbook to approved (v{p.version ?? "—"}). Any prior approved playbook is demoted.
        </p>
      ) : (
        <div className="space-y-1 text-xs">
          {p.reasoning && <p className="text-muted-foreground">{p.reasoning}</p>}
          <ul className="mt-1 space-y-1 rounded bg-muted/50 p-2 font-mono text-[11px]">
            {(p.diff ?? []).slice(0, 6).map((d, i) => (
              <li key={i}>
                <span className="text-purple-700">{d.path}</span>:{" "}
                <span className="text-muted-foreground line-through">{stringify(d.before)}</span>{" "}
                → <span className="text-foreground">{stringify(d.after)}</span>
              </li>
            ))}
            {(p.diff ?? []).length > 6 && (
              <li className="text-muted-foreground">… and {p.diff.length - 6} more changes</li>
            )}
          </ul>
        </div>
      )}
      {error && <Alert variant="destructive" className="mt-3">{error}</Alert>}
      {isPending && (
        <div className="mt-4 flex gap-2">
          <Button onClick={onApprove} disabled={pending} size="sm">
            <Check className="mr-1.5 h-3 w-3" /> Approve
          </Button>
          <Button variant="outline" onClick={onReject} disabled={pending} size="sm">
            <X className="mr-1.5 h-3 w-3" /> Reject
          </Button>
        </div>
      )}
    </>
  );
}

function HumanStageTaskBody({ approval, isPending }: { approval: ApprovalRow; isPending: boolean }) {
  const p = (approval.payload as HumanStageTaskPayload & { lead_id?: string }) ?? {};
  // Pull a friendly lead name from the title (which we set on insert as
  // "<Company>: <Stage>") so the body can read naturally.
  const [companyPart, stageNameFromTitle] = approval.title.split(":").map((s) => s.trim());
  const stageName = p.stage_name ?? stageNameFromTitle ?? "this stage";
  const company = companyPart ?? approval.clients?.name ?? "This lead";
  const leadId = p.lead_id ?? null;

  return (
    <>
      <p className="mb-3 rounded-md bg-amber-100/60 px-3 py-2 text-sm text-amber-900">
        <strong>{company}</strong> has reached the <strong>{stageName}</strong> stage. Mark this complete once you&apos;ve done the human action (e.g. taken the meeting).
      </p>
      {p.message && p.message !== approval.summary && (
        <p className="text-xs text-muted-foreground">{p.message}</p>
      )}
      {isPending && (
        <div className="mt-4">
          {leadId ? (
            <Button asChild size="sm">
              <Link href={`/leads/${leadId}`}>
                <ExternalLink className="mr-1.5 h-3 w-3" /> Go to lead
              </Link>
            </Button>
          ) : (
            <p className="text-xs text-muted-foreground">No lead reference on this approval.</p>
          )}
        </div>
      )}
    </>
  );
}

function ProposalReviewBody({ approval, isPending }: { approval: ApprovalRow; isPending: boolean }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(true);

  const p = (approval.payload ?? {}) as Partial<ProposalReviewPayload>;
  const [subject, setSubject] = useState(p.drafted_subject ?? "");
  const [body, setBody] = useState(p.drafted_body ?? "");

  function onApprove() {
    setError(null);
    if (!subject.trim() || !body.trim()) {
      setError("Subject and body are required.");
      return;
    }
    if (!confirm("Send this proposal email?")) return;
    start(async () => {
      const r = await approveProposalReview({
        approval_id: approval.id,
        edited_subject: subject.trim(),
        edited_body: body.trim(),
      });
      if (!r.ok) {
        setError(r.error);
        return;
      }
      router.refresh();
    });
  }
  function onReject() {
    setError(null);
    if (!confirm("Reject this draft? It will not be sent.")) return;
    start(async () => {
      const r = await rejectApproval({ id: approval.id });
      if (!r.ok) {
        setError(r.error);
        return;
      }
      router.refresh();
    });
  }

  return (
    <>
      {approval.summary && (
        <p className="mb-3 rounded-md bg-muted px-3 py-2 text-sm text-muted-foreground">
          {approval.summary}
        </p>
      )}
      {p.outcome && (
        <p className="mb-2 text-xs text-muted-foreground">
          Meeting outcome: <strong className="text-foreground">{p.outcome}</strong>
        </p>
      )}
      {p.ai_warning && (
        <Alert className="mb-3 border-amber-300 bg-amber-50 text-amber-900">{p.ai_warning}</Alert>
      )}

      <div className="rounded-lg border bg-background">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm font-medium hover:bg-muted/50"
        >
          <span>Drafted proposal</span>
          {open ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
        </button>
        {open && (
          <div className="space-y-3 border-t px-3 py-3">
            <div className="space-y-1.5">
              <Label htmlFor={`subj-${approval.id}`} className="text-xs uppercase tracking-wider">
                Subject
              </Label>
              <Input
                id={`subj-${approval.id}`}
                value={subject}
                onChange={(e) => setSubject(e.target.value)}
                disabled={!isPending}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor={`body-${approval.id}`} className="text-xs uppercase tracking-wider">
                Body
              </Label>
              <Textarea
                id={`body-${approval.id}`}
                value={body}
                onChange={(e) => setBody(e.target.value)}
                rows={10}
                disabled={!isPending}
                className="font-mono text-xs"
              />
            </div>
          </div>
        )}
      </div>

      {error && <Alert variant="destructive" className="mt-3">{error}</Alert>}

      {isPending && (
        <div className="mt-4 flex gap-2">
          <Button onClick={onApprove} disabled={pending} size="sm">
            <Mail className="mr-1.5 h-3 w-3" />
            {pending ? "Sending…" : "Approve & Send"}
          </Button>
          <Button variant="outline" onClick={onReject} disabled={pending} size="sm">
            <X className="mr-1.5 h-3 w-3" /> Reject draft
          </Button>
        </div>
      )}
    </>
  );
}

function PlaybookApprovalBody({
  approval,
  isPending,
}: {
  approval: ApprovalRow;
  isPending: boolean;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const p = (approval.payload ?? {}) as Partial<PlaybookApprovalPayload>;
  const playbookId = approval.related_playbook_id;
  const reviewLink = playbookId ? `/playbooks/${playbookId}` : null;

  function onApprove() {
    setError(null);
    if (
      !confirm(
        "Approve this playbook? It will become the live, approved version for this client and the sales agents will go live.",
      )
    )
      return;
    start(async () => {
      const r = await approveApproval({ id: approval.id });
      if (!r.ok) {
        setError(r.error);
        return;
      }
      router.refresh();
    });
  }
  function onReject() {
    setError(null);
    if (!confirm("Reject this playbook? The client will need to redo the interview.")) return;
    start(async () => {
      const r = await rejectApproval({ id: approval.id });
      if (!r.ok) {
        setError(r.error);
        return;
      }
      router.refresh();
    });
  }

  return (
    <>
      {approval.summary && (
        <p className="mb-3 rounded-md bg-muted px-3 py-2 text-sm text-muted-foreground">
          {approval.summary}
        </p>
      )}
      <div className="rounded-lg border border-violet-200 bg-violet-50/40 p-3 text-sm text-violet-900">
        <p>
          <strong>{p.client_name ?? "The client"}</strong> finished the onboarding
          interview and approved their generated playbook
          {(p.feedback_round_count ?? 0) > 0
            ? ` after ${p.feedback_round_count} round${(p.feedback_round_count ?? 0) === 1 ? "" : "s"} of revisions`
            : ""}
          . Final HOS sign-off here makes the playbook live and the agents
          start running.
        </p>
      </div>
      {error && <Alert variant="destructive" className="mt-3">{error}</Alert>}
      {isPending && (
        <div className="mt-4 flex flex-wrap gap-2">
          {reviewLink && (
            <Button asChild variant="outline" size="sm">
              <Link href={reviewLink}>
                <ExternalLink className="mr-1.5 h-3 w-3" /> Review playbook
              </Link>
            </Button>
          )}
          <Button onClick={onApprove} disabled={pending} size="sm">
            <Check className="mr-1.5 h-3 w-3" /> Approve · Go live
          </Button>
          <Button variant="outline" onClick={onReject} disabled={pending} size="sm">
            <X className="mr-1.5 h-3 w-3" /> Reject
          </Button>
        </div>
      )}
    </>
  );
}

function ReplyReviewBody({
  approval,
  isPending,
}: {
  approval: ApprovalRow;
  isPending: boolean;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(true);

  const p = (approval.payload ?? {}) as Partial<ReplyReviewPayload>;
  const [subject, setSubject] = useState(p.drafted_subject ?? "");
  const [body, setBody] = useState(p.drafted_body ?? "");

  function onApprove() {
    setError(null);
    if (!subject.trim() || !body.trim()) {
      setError("Subject and body are required.");
      return;
    }
    if (!confirm("Send this reply?")) return;
    start(async () => {
      const r = await approveReplyReview({
        approval_id: approval.id,
        edited_subject: subject.trim(),
        edited_body: body.trim(),
      });
      if (!r.ok) {
        setError(r.error);
        return;
      }
      router.refresh();
    });
  }
  function onReject() {
    setError(null);
    if (!confirm("Reject this draft? It won't be sent.")) return;
    start(async () => {
      const r = await rejectApproval({ id: approval.id });
      if (!r.ok) {
        setError(r.error);
        return;
      }
      router.refresh();
    });
  }

  return (
    <>
      {approval.summary && (
        <p className="mb-3 rounded-md bg-muted px-3 py-2 text-sm text-muted-foreground">
          {approval.summary}
        </p>
      )}
      {p.reply_kind && (
        <p className="mb-2 text-xs text-muted-foreground">
          Reply kind: <strong className="text-foreground">{p.reply_kind}</strong>
          {p.booking_link && (
            <>
              {" · "}
              <span className="text-emerald-700">Booking link embedded</span>
            </>
          )}
        </p>
      )}
      {p.incoming_excerpt && (
        <div className="mb-3 rounded-md border border-border/60 bg-muted/30 p-3 text-xs">
          <p className="text-muted-foreground">
            They wrote {p.incoming_subject ? `(subject "${p.incoming_subject}")` : ""}:
          </p>
          <p className="mt-1 whitespace-pre-wrap text-foreground/80">{p.incoming_excerpt}</p>
        </div>
      )}

      <div className="rounded-lg border bg-background">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm font-medium hover:bg-muted/50"
        >
          <span>Drafted reply</span>
          {open ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
        </button>
        {open && (
          <div className="space-y-3 border-t px-3 py-3">
            <div className="space-y-1.5">
              <Label htmlFor={`reply-subj-${approval.id}`} className="text-xs uppercase tracking-wider">
                Subject
              </Label>
              <Input
                id={`reply-subj-${approval.id}`}
                value={subject}
                onChange={(e) => setSubject(e.target.value)}
                disabled={!isPending}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor={`reply-body-${approval.id}`} className="text-xs uppercase tracking-wider">
                Body
              </Label>
              <Textarea
                id={`reply-body-${approval.id}`}
                value={body}
                onChange={(e) => setBody(e.target.value)}
                rows={10}
                disabled={!isPending}
                className="font-mono text-xs"
              />
            </div>
          </div>
        )}
      </div>

      {error && <Alert variant="destructive" className="mt-3">{error}</Alert>}

      {isPending && (
        <div className="mt-4 flex gap-2">
          <Button onClick={onApprove} disabled={pending} size="sm">
            <Mail className="mr-1.5 h-3 w-3" />
            {pending ? "Sending…" : "Approve & Send"}
          </Button>
          <Button variant="outline" onClick={onReject} disabled={pending} size="sm">
            <X className="mr-1.5 h-3 w-3" /> Reject draft
          </Button>
        </div>
      )}
    </>
  );
}

function stringify(v: unknown): string {
  if (typeof v === "string") return v.length > 60 ? `"${v.slice(0, 60)}…"` : `"${v}"`;
  return JSON.stringify(v);
}
