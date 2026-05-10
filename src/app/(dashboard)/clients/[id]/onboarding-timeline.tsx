"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Alert } from "@/components/ui/alert";
import {
  CheckCircle2,
  Circle,
  Clock,
  ExternalLink,
  RefreshCw,
  Sparkles,
} from "lucide-react";
import { formatDateTime } from "@/lib/utils";
import type { OnboardingSession, OnboardingStatus } from "@/lib/supabase/types";

const STEPS: Array<{ status: OnboardingStatus; label: string }> = [
  { status: "pending", label: "Interview sent" },
  { status: "in_progress", label: "In progress" },
  { status: "completed", label: "Interview completed" },
  { status: "playbook_generated", label: "Playbook generated" },
  { status: "approved", label: "Client approved" },
];

const STATUS_INDEX: Record<OnboardingStatus, number> = {
  pending: 0,
  in_progress: 1,
  completed: 2,
  playbook_generated: 3,
  approved: 4,
};

export function OnboardingTimelineCard({
  sessions,
}: {
  sessions: OnboardingSession[];
}) {
  if (sessions.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Client onboarding</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">
            No onboarding session yet. One starts automatically the first time
            this client&apos;s lead receives an approved proposal email.
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-3">
      {sessions.map((s) => (
        <SessionCard key={s.id} session={s} />
      ))}
    </div>
  );
}

function SessionCard({ session }: { session: OnboardingSession }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  const currentIdx = STATUS_INDEX[session.status];
  const link = `${typeof window !== "undefined" ? window.location.origin : ""}/onboard/${session.token}`;
  const feedbackCount = (session.feedback_rounds ?? []).length;

  function resend() {
    setError(null);
    setInfo(null);
    if (!confirm("Resend the onboarding interview email to the contact?")) return;
    start(async () => {
      const res = await fetch(`/api/onboarding/${session.token}/resend`, {
        method: "POST",
      });
      const json = (await res.json().catch(() => null)) as
        | { ok: boolean; error?: string; warning?: string | null; email_sent?: boolean }
        | null;
      if (!json?.ok) {
        setError(json?.error ?? "Failed to resend.");
        return;
      }
      setInfo(
        json.email_sent
          ? "Email resent."
          : `Tried to resend but: ${json.warning ?? "no email sent"}`,
      );
      router.refresh();
    });
  }

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0">
        <div>
          <CardTitle className="text-base flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-emerald-600" />
            Client onboarding
          </CardTitle>
          <p className="mt-1 text-xs text-muted-foreground">
            Created {formatDateTime(session.created_at)}
            {feedbackCount > 0 && ` · ${feedbackCount} round${feedbackCount === 1 ? "" : "s"} of feedback`}
          </p>
        </div>
        <div className="flex gap-2">
          <Button asChild variant="outline" size="sm">
            <Link href={link} target="_blank" rel="noreferrer">
              <ExternalLink className="mr-1.5 h-3 w-3" /> Open as client
            </Link>
          </Button>
          <Button variant="outline" size="sm" onClick={resend} disabled={pending}>
            <RefreshCw className="mr-1.5 h-3 w-3" /> Resend
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        <ol className="relative space-y-3 border-l border-border pl-4">
          {STEPS.map((step, i) => {
            const done = i < currentIdx || (session.status === "approved" && i === currentIdx);
            const here = i === currentIdx && session.status !== "approved";
            return (
              <li key={step.status} className="flex items-start gap-3">
                <span
                  className={`-ml-[1.4rem] mt-0.5 flex h-4 w-4 items-center justify-center rounded-full border ${
                    done
                      ? "border-emerald-500 bg-emerald-500 text-white"
                      : here
                        ? "border-amber-500 bg-amber-100 text-amber-700"
                        : "border-border bg-background text-muted-foreground"
                  }`}
                >
                  {done ? (
                    <CheckCircle2 className="h-3 w-3" />
                  ) : here ? (
                    <Clock className="h-2.5 w-2.5" />
                  ) : (
                    <Circle className="h-2 w-2" />
                  )}
                </span>
                <div className="text-sm">
                  <p
                    className={`font-medium ${
                      done ? "text-foreground" : here ? "text-foreground" : "text-muted-foreground"
                    }`}
                  >
                    {step.label}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {timestampFor(session, step.status)}
                  </p>
                </div>
              </li>
            );
          })}
        </ol>

        {error && (
          <Alert variant="destructive" className="mt-3">
            {error}
          </Alert>
        )}
        {info && (
          <Alert className="mt-3 border-emerald-300 bg-emerald-50 text-emerald-900">
            {info}
          </Alert>
        )}

        <div className="mt-4 rounded-md border bg-muted/30 px-3 py-2 text-xs">
          <p className="text-muted-foreground">Public interview link</p>
          <p className="mt-0.5 truncate font-mono text-foreground">{link}</p>
        </div>
      </CardContent>
    </Card>
  );
}

function timestampFor(session: OnboardingSession, step: OnboardingStatus): string {
  switch (step) {
    case "pending":
      return session.sent_at ? `Sent ${formatDateTime(session.sent_at)}` : "Not sent yet";
    case "in_progress": {
      const turns = (session.answers?.questions ?? []).length;
      if (turns === 0) return "Not started";
      return `${turns} answer${turns === 1 ? "" : "s"} so far`;
    }
    case "completed":
      return session.completed_at ? formatDateTime(session.completed_at) : "—";
    case "playbook_generated":
      return session.generated_playbook ? "Draft ready" : "—";
    case "approved":
      return session.approved_at ? formatDateTime(session.approved_at) : "—";
    default:
      return "—";
  }
}
