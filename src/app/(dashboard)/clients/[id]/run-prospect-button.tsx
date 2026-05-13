"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Alert } from "@/components/ui/alert";
import { Sparkles } from "lucide-react";
import type { ProviderConfig, ProviderName } from "@/lib/agents/providers";

type RunResult = {
  ok: true;
  found: number;
  new: number;
  duplicates: number;
  approval_id: string | null;
  provider_used?: ProviderName;
};

export function RunProspectButton({
  clientId,
  providerConfig,
}: {
  clientId: string;
  providerConfig: ProviderConfig;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<RunResult | null>(null);

  const noProvider = providerConfig.primary === null;

  function onClick() {
    if (noProvider) return;
    setError(null);
    setResult(null);
    start(async () => {
      try {
        const res = await fetch("/api/agents/prospect", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ client_id: clientId }),
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
      <div className="flex flex-col gap-1">
        <Button
          onClick={onClick}
          disabled={pending || noProvider}
          size="sm"
          variant="outline"
          title={
            noProvider
              ? "No prospecting provider configured. Set APOLLO_API_KEY or HUNTER_API_KEY."
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
          Sourced via <strong>{result.provider_used ?? "unknown"}</strong> ·{" "}
          Found <strong>{result.found}</strong> contacts ·{" "}
          <strong>{result.new}</strong> new ·{" "}
          <strong>{result.duplicates}</strong> dedup&apos;d
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
