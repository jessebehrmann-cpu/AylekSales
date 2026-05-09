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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Check, X, Search, RefreshCw, Plus, ExternalLink } from "lucide-react";
import { approveApproval, rejectApproval } from "./actions";
import type {
  Approval,
  LeadListPayload,
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
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const isPending = approval.status === "pending";
  const Icon = approval.type === "lead_list" ? Search : RefreshCw;
  const iconBg =
    approval.type === "lead_list"
      ? "bg-emerald-100 text-emerald-700"
      : "bg-purple-100 text-purple-700";

  // Lead-list approvals: resolve a campaign at decision time.
  const leadListPayload =
    approval.type === "lead_list" ? (approval.payload as LeadListPayload) : null;
  const payloadCampaignId = leadListPayload?.campaign_id ?? null;
  const needsCampaignChoice = approval.type === "lead_list" && !payloadCampaignId;

  // Default selection: if payload already has a campaign, lock to that; else
  // first eligible client campaign; else "create new".
  const initialChoice =
    payloadCampaignId ??
    clientCampaigns[0]?.id ??
    (needsCampaignChoice ? NEW_CAMPAIGN_VALUE : "");
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
    if (approval.type === "lead_list" && needsCampaignChoice) {
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

    if (
      !confirm(
        approval.type === "lead_list"
          ? "Approve and start outreach?"
          : "Approve this strategy change?",
      )
    )
      return;

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
    <Card className={isPending ? "border-amber-200 bg-amber-50/30" : undefined}>
      <CardContent className="pt-6">
        <div className="mb-3 flex items-start gap-3">
          <div className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-lg ${iconBg}`}>
            <Icon className="h-5 w-5" />
          </div>
          <div className="flex-1">
            <p className="font-semibold">{approval.title}</p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {approval.clients?.name ? `${approval.clients.name} · ` : ""}
              {approval.type === "lead_list" ? "Lead list" : "Strategy change"} ·{" "}
              {formatDateTime(approval.created_at)}
            </p>
          </div>
          <Badge variant={statusVariant(approval.status)}>{approval.status}</Badge>
        </div>

        {approval.summary && (
          <p className="mb-3 rounded-md bg-muted px-3 py-2 text-sm text-muted-foreground">
            {approval.summary}
          </p>
        )}

        <PayloadDetail approval={approval} batchLeads={batchLeads} />

        {/* Campaign picker — only for lead_list approvals without a campaign_id baked in */}
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
                      {c.name}{" "}
                      <span className="ml-1 text-xs text-muted-foreground">· {c.status}</span>
                    </SelectItem>
                  ))}
                  <SelectItem value={NEW_CAMPAIGN_VALUE}>
                    + Create a new campaign
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>
            {campaignChoice === NEW_CAMPAIGN_VALUE && (
              <div className="space-y-1.5">
                <Label htmlFor={`new-name-${approval.id}`} className="text-xs uppercase tracking-wider flex items-center gap-1">
                  <Plus className="h-3 w-3" /> New campaign name
                </Label>
                <Input
                  id={`new-name-${approval.id}`}
                  value={newCampaignName}
                  onChange={(e) => setNewCampaignName(e.target.value)}
                  placeholder="e.g. Q3 Outbound — APAC"
                />
                <p className="text-xs text-muted-foreground">
                  Uses this client&apos;s approved playbook sequence. Will activate immediately.
                </p>
              </div>
            )}
            {clientCampaigns.length === 0 && campaignChoice !== NEW_CAMPAIGN_VALUE && (
              <p className="text-xs text-amber-800">
                No campaigns yet for this client — create one to enrol these leads.
              </p>
            )}
          </div>
        )}

        {error && error !== "needs_campaign" && (
          <Alert variant="destructive" className="mt-3">{error}</Alert>
        )}

        {isPending && (
          <div className="mt-4 flex gap-2">
            <Button onClick={onApprove} disabled={pending} size="sm">
              <Check className="mr-1.5 h-3 w-3" />
              {approval.type === "lead_list" ? "Approve · Start outreach" : "Approve"}
            </Button>
            <Button variant="outline" onClick={onReject} disabled={pending} size="sm">
              <X className="mr-1.5 h-3 w-3" />
              Reject
            </Button>
          </div>
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

function PayloadDetail({
  approval,
  batchLeads,
}: {
  approval: Approval;
  batchLeads: BatchLead[];
}) {
  if (approval.type === "lead_list") {
    const p = approval.payload as LeadListPayload;
    const total = p.lead_ids?.length ?? 0;
    const preview = batchLeads.slice(0, 6);
    const remaining = total - preview.length;
    return (
      <div className="space-y-2 text-xs text-muted-foreground">
        <p>
          <span className="font-medium text-foreground">{total}</span> lead{total === 1 ? "" : "s"} in this batch
          {p.source && ` · sourced from ${p.source}`}
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
    );
  }
  if (approval.type === "strategy_change") {
    const p = approval.payload as StrategyChangePayload & { mode?: string; version?: number };
    if (p.mode === "promote_draft") {
      return (
        <p className="text-xs text-muted-foreground">
          Promotes the draft playbook to approved (v{p.version ?? "—"}). Any prior approved playbook is demoted.
        </p>
      );
    }
    return (
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
    );
  }
  return null;
}

function stringify(v: unknown): string {
  if (typeof v === "string") return v.length > 60 ? `"${v.slice(0, 60)}…"` : `"${v}"`;
  return JSON.stringify(v);
}
