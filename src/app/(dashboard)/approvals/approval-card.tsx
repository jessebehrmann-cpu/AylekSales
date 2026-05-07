"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Alert } from "@/components/ui/alert";
import { Check, X, Search, RefreshCw } from "lucide-react";
import { approveApproval, rejectApproval } from "./actions";
import type {
  Approval,
  LeadListPayload,
  StrategyChangePayload,
} from "@/lib/supabase/types";
import { formatDateTime } from "@/lib/utils";

type ApprovalRow = Approval & { clients: { name: string } | null };

export function ApprovalCard({ approval }: { approval: ApprovalRow }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const isPending = approval.status === "pending";
  const Icon = approval.type === "lead_list" ? Search : RefreshCw;
  const iconBg =
    approval.type === "lead_list"
      ? "bg-emerald-100 text-emerald-700"
      : "bg-purple-100 text-purple-700";

  function onApprove() {
    setError(null);
    if (!confirm(approval.type === "lead_list" ? "Approve and start outreach?" : "Approve this strategy change?")) return;
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

        <PayloadDetail approval={approval} />

        {error && <Alert variant="destructive" className="mt-3">{error}</Alert>}

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

function PayloadDetail({ approval }: { approval: Approval }) {
  if (approval.type === "lead_list") {
    const p = approval.payload as LeadListPayload;
    return (
      <div className="space-y-1 text-xs text-muted-foreground">
        <p>
          <span className="font-medium text-foreground">{p.lead_ids?.length ?? 0}</span> leads in this batch
          {p.source && ` · sourced from ${p.source}`}
        </p>
        {!p.campaign_id && (
          <p className="text-amber-700">No campaign attached — approval will fail until one is set.</p>
        )}
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
