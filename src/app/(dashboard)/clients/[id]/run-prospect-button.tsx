"use client";

import { useMemo, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Alert } from "@/components/ui/alert";
import { Sparkles } from "lucide-react";
import type { ProviderConfig, ProviderName } from "@/lib/agents/providers";
import type { PlaybookSegment } from "@/lib/supabase/types";

type RunResult = {
  ok: true;
  found: number;
  new: number;
  duplicates: number;
  approval_id: string | null;
  provider_used?: ProviderName;
  segment_id?: string;
  segment_name?: string;
  segment_runs_completed?: number;
  segment_leads_remaining?: number;
};

const NO_SEGMENT_VALUE = "__catch_all__";

/**
 * Item 7 — segment-aware Prospect-01 button. When the client's approved
 * playbook has segments, HOS picks which segment to source from via a
 * dropdown. Exhausted / rejected segments are hidden so the dropdown
 * stays clean; if every segment is gone the dropdown disappears and the
 * button falls back to the catch-all playbook ICP (back-compat with
 * pre-Item-7 playbooks).
 */
export function RunProspectButton({
  clientId,
  providerConfig,
  segments,
}: {
  clientId: string;
  providerConfig: ProviderConfig;
  segments?: PlaybookSegment[];
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<RunResult | null>(null);

  const runnableSegments = useMemo(
    () => (segments ?? []).filter((s) => s.status === "active" || s.status === "pending_approval"),
    [segments],
  );
  const hasSegments = runnableSegments.length > 0;
  const [segmentChoice, setSegmentChoice] = useState<string>(
    hasSegments ? runnableSegments[0].id : NO_SEGMENT_VALUE,
  );

  const noProvider = providerConfig.primary === null;
  const chosenSegment =
    segmentChoice !== NO_SEGMENT_VALUE
      ? runnableSegments.find((s) => s.id === segmentChoice) ?? null
      : null;

  function onClick() {
    if (noProvider) return;
    setError(null);
    setResult(null);
    start(async () => {
      try {
        const res = await fetch("/api/agents/prospect", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            client_id: clientId,
            ...(chosenSegment ? { segment_id: chosenSegment.id } : {}),
          }),
        });
        const json = await res.json();
        if (!res.ok || !json.ok) {
          setError(json.error ?? `HTTP ${res.status}`);
          return;
        }
        setResult(json as RunResult);
        router.refresh();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    });
  }

  return (
    <div className="space-y-2">
      {hasSegments && (
        <div className="flex flex-col gap-1">
          <label className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
            Segment
          </label>
          <select
            value={segmentChoice}
            onChange={(e) => setSegmentChoice(e.target.value)}
            disabled={pending || noProvider}
            className="h-9 rounded-md border border-input bg-background px-2 text-sm"
          >
            {runnableSegments.map((s, i) => {
              const total = runnableSegments.length;
              const runIndex = (s.runs_completed ?? 0) + 1;
              const leftCopy =
                typeof s.leads_remaining === "number"
                  ? `${s.leads_remaining.toLocaleString()} left`
                  : `${s.estimated_pool_size.toLocaleString()} pool`;
              return (
                <option key={s.id} value={s.id}>
                  {s.name} · Run {runIndex} of {total} · {leftCopy}
                </option>
              );
            })}
            <option value={NO_SEGMENT_VALUE}>
              Catch-all (use the broad playbook ICP, ignore segments)
            </option>
          </select>
        </div>
      )}

      <div className="flex flex-col gap-1">
        <Button
          onClick={onClick}
          disabled={pending || noProvider}
          size="sm"
          variant="outline"
          title={
            noProvider
              ? "No prospecting provider configured. Set APOLLO_API_KEY or HUNTER_API_KEY."
              : chosenSegment
                ? `Will source ${chosenSegment.name} via ${providerConfig.reason}.`
                : `Will source via ${providerConfig.reason}.`
          }
        >
          <Sparkles className="mr-1.5 h-4 w-4" />
          {pending ? "Running Prospect-01…" : "Run Prospect-01"}
        </Button>
        <p className="text-[11px] text-muted-foreground">
          {noProvider ? (
            <span className="text-destructive">
              No prospecting provider configured — set APOLLO_API_KEY or HUNTER_API_KEY.
            </span>
          ) : (
            <ProviderCaption config={providerConfig} />
          )}
        </p>
      </div>
      {error && <Alert variant="destructive">{error}</Alert>}
      {result && (
        <Alert variant="success">
          Sourced via <strong>{result.provider_used ?? "unknown"}</strong>
          {result.segment_name && (
            <>
              {" "}
              from <strong>{result.segment_name}</strong>
            </>
          )}{" "}
          · Found <strong>{result.found}</strong> contacts ·{" "}
          <strong>{result.new}</strong> new ·{" "}
          <strong>{result.duplicates}</strong> dedup&apos;d
          {typeof result.segment_leads_remaining === "number" && (
            <> · {result.segment_leads_remaining.toLocaleString()} left in segment</>
          )}
          {result.approval_id && (
            <>
              {" — "}
              <Link
                href={`/approvals?status=pending`}
                className="font-medium underline"
              >
                Open the approval queue
              </Link>
            </>
          )}
        </Alert>
      )}
    </div>
  );
}

function ProviderCaption({ config }: { config: ProviderConfig }) {
  if (config.primary && config.fallback) {
    return (
      <>
        Primary: <strong>{config.primary}</strong> · Fallback:{" "}
        <strong>{config.fallback}</strong> (auto on 403 / 429 / 5xx)
      </>
    );
  }
  return (
    <>
      Provider: <strong>{config.primary}</strong> · no fallback configured
    </>
  );
}
