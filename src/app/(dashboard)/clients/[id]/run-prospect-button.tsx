"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Alert } from "@/components/ui/alert";
import { Sparkles } from "lucide-react";

type RunResult = {
  ok: true;
  found: number;
  new: number;
  duplicates: number;
  approval_id: string | null;
};

export function RunProspectButton({ clientId }: { clientId: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<RunResult | null>(null);

  function onClick() {
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
      <Button onClick={onClick} disabled={pending} size="sm" variant="outline">
        <Sparkles className="mr-1.5 h-4 w-4" />
        {pending ? "Running Prospect-01…" : "Run Prospect-01"}
      </Button>
      {error && <Alert variant="destructive">{error}</Alert>}
      {result && (
        <Alert variant="success">
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
