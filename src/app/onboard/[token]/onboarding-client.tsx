"use client";

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Alert } from "@/components/ui/alert";
import {
  Send,
  Sparkles,
  CheckCircle2,
  MessageSquare,
  RefreshCw,
} from "lucide-react";
import type {
  CoreTopic,
  NextQuestion,
} from "@/lib/onboarding";
import type {
  GeneratedPlaybookDraft,
  OnboardingAnswers,
  OnboardingFeedbackRound,
  OnboardingStatus,
  SalesProcessStage,
} from "@/lib/supabase/types";

type Stage =
  | { kind: "welcome" }
  | { kind: "interview" }
  | { kind: "generating" }
  | { kind: "playbook" }
  | { kind: "regenerating" }
  | { kind: "approved" };

export function OnboardingClient(props: {
  token: string;
  clientName: string;
  initialStatus: OnboardingStatus;
  initialAnswers: OnboardingAnswers;
  initialPlaybook: GeneratedPlaybookDraft | null;
  initialFeedbackRounds: OnboardingFeedbackRound[];
  initialQuestion: NextQuestion | null;
  coreTopics: CoreTopic[];
}) {
  const initialStage: Stage = (() => {
    if (props.initialStatus === "approved") return { kind: "approved" };
    if (props.initialStatus === "playbook_generated") return { kind: "playbook" };
    if ((props.initialAnswers.questions ?? []).length === 0) return { kind: "welcome" };
    return { kind: "interview" };
  })();

  const [stage, setStage] = useState<Stage>(initialStage);
  const [transcript, setTranscript] = useState<
    Array<{ role: "assistant" | "user"; topic: string; text: string }>
  >(() => {
    const turns = props.initialAnswers.questions ?? [];
    const out: Array<{ role: "assistant" | "user"; topic: string; text: string }> = [];
    for (const t of turns) {
      out.push({ role: "assistant", topic: t.topic, text: t.question });
      out.push({ role: "user", topic: t.topic, text: t.answer });
    }
    // Seed the first assistant turn whenever there's an initial question,
    // regardless of stage. The welcome screen renders its own JSX so this
    // doesn't show until the user clicks "Start the interview" — at which
    // point the chat already has the question rendered above the input box.
    if (props.initialQuestion) {
      out.push({
        role: "assistant",
        topic: props.initialQuestion.topic,
        text: props.initialQuestion.question,
      });
    }
    return out;
  });
  const [currentQ, setCurrentQ] = useState<NextQuestion | null>(props.initialQuestion);
  const [draftAnswer, setDraftAnswer] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const [playbook, setPlaybook] = useState<GeneratedPlaybookDraft | null>(props.initialPlaybook);
  const [feedbackRounds, setFeedbackRounds] = useState<OnboardingFeedbackRound[]>(
    props.initialFeedbackRounds,
  );
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const [feedbackText, setFeedbackText] = useState("");
  const [warning, setWarning] = useState<string | null>(null);

  // ────────────────────────────────────────────────────────────────────
  // Welcome → start
  // ────────────────────────────────────────────────────────────────────
  if (stage.kind === "welcome") {
    return (
      <Shell clientName={props.clientName}>
        <div className="mx-auto flex max-w-2xl flex-col gap-6 px-6 py-16 text-center">
          <Sparkles className="mx-auto h-10 w-10 text-emerald-600" />
          <div>
            <h1 className="text-3xl font-semibold tracking-tight">
              Welcome, {props.clientName}.
            </h1>
            <p className="mt-3 text-base text-muted-foreground">
              I&apos;m going to ask you a few short questions about your business and
              how you sell. About 15 minutes. After that, I&apos;ll draft your sales
              playbook end-to-end — ICP, messaging, voice, sequences, conditions
              — and you&apos;ll review it before anything goes live.
            </p>
          </div>
          <div className="rounded-lg border bg-muted/40 p-4 text-left text-sm text-muted-foreground">
            <p className="font-medium text-foreground mb-2">What we&apos;ll cover</p>
            <ul className="space-y-1.5">
              {props.coreTopics.map((t) => (
                <li key={t.id}>• {t.label}</li>
              ))}
            </ul>
          </div>
          <Button
            size="lg"
            onClick={() => setStage({ kind: "interview" })}
            className="mx-auto"
          >
            Start the interview <Send className="ml-2 h-4 w-4" />
          </Button>
        </div>
      </Shell>
    );
  }

  // ────────────────────────────────────────────────────────────────────
  // Interview chat
  // ────────────────────────────────────────────────────────────────────
  if (stage.kind === "interview") {
    function submitAnswer() {
      if (!currentQ) return;
      const ans = draftAnswer.trim();
      if (ans.length === 0) {
        setError("Type something before sending.");
        return;
      }
      setError(null);
      setWarning(null);
      const userMsg = { role: "user" as const, topic: currentQ.topic, text: ans };
      setTranscript((t) => [...t, userMsg]);
      setDraftAnswer("");
      start(async () => {
        const res = await fetch(`/api/onboarding/${props.token}/answer`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            topic: currentQ.topic,
            question: currentQ.question,
            answer: ans,
          }),
        });
        const json = (await res.json().catch(() => null)) as {
          ok: boolean;
          error?: string;
          next_question?: NextQuestion;
        } | null;
        if (!json?.ok || !json.next_question) {
          setError(json?.error ?? "Something went wrong saving your answer.");
          return;
        }
        if (json.next_question.warning) setWarning(json.next_question.warning);
        setCurrentQ(json.next_question);
        setTranscript((t) => [
          ...t,
          {
            role: "assistant",
            topic: json.next_question!.topic,
            text: json.next_question!.question,
          },
        ]);
      });
    }

    function imDone() {
      if (
        !confirm(
          "Done with the interview? I'll draft your full playbook now — takes ~30 seconds.",
        )
      )
        return;
      setError(null);
      setWarning(null);
      setStage({ kind: "generating" });
      start(async () => {
        const res = await fetch(`/api/onboarding/${props.token}/complete`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({}),
        });
        const json = (await res.json().catch(() => null)) as {
          ok: boolean;
          error?: string;
          playbook?: GeneratedPlaybookDraft;
          warning?: string | null;
        } | null;
        if (!json?.ok || !json.playbook) {
          setError(json?.error ?? "Failed to generate playbook.");
          setStage({ kind: "interview" });
          return;
        }
        if (json.warning) setWarning(json.warning);
        setPlaybook(json.playbook);
        setStage({ kind: "playbook" });
      });
    }

    return (
      <Shell clientName={props.clientName}>
        <div className="mx-auto flex h-screen max-w-3xl flex-col px-4 py-6">
          <div className="flex-1 space-y-6 overflow-y-auto rounded-xl border bg-card p-6 shadow-sm">
            {transcript.map((m, i) => (
              <ChatBubble key={i} role={m.role} text={m.text} />
            ))}
            {pending && stage.kind === "interview" && (
              <ChatBubble role="assistant" text="…" muted />
            )}
          </div>
          {warning && (
            <Alert className="mt-3 border-amber-300 bg-amber-50 text-amber-900">{warning}</Alert>
          )}
          {error && (
            <Alert variant="destructive" className="mt-3">
              {error}
            </Alert>
          )}
          <div className="mt-3 rounded-xl border bg-card p-3 shadow-sm">
            <Textarea
              value={draftAnswer}
              onChange={(e) => setDraftAnswer(e.target.value)}
              placeholder="Type your answer…"
              rows={3}
              disabled={pending}
              onKeyDown={(e) => {
                if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                  e.preventDefault();
                  submitAnswer();
                }
              }}
            />
            <div className="mt-2 flex items-center justify-between">
              <p className="text-[11px] text-muted-foreground">
                ⌘/Ctrl + Enter to send · {transcript.length / 2 | 0} answers so
                far
              </p>
              <div className="flex items-center gap-2">
                {currentQ?.ready_to_complete && (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={imDone}
                    disabled={pending}
                  >
                    <CheckCircle2 className="mr-1.5 h-3.5 w-3.5" /> I&apos;m done
                  </Button>
                )}
                <Button onClick={submitAnswer} disabled={pending || !draftAnswer.trim()} size="sm">
                  Send <Send className="ml-1.5 h-3.5 w-3.5" />
                </Button>
              </div>
            </div>
          </div>
        </div>
      </Shell>
    );
  }

  // ────────────────────────────────────────────────────────────────────
  // Generating spinner
  // ────────────────────────────────────────────────────────────────────
  if (stage.kind === "generating" || stage.kind === "regenerating") {
    return (
      <Shell clientName={props.clientName}>
        <div className="mx-auto flex max-w-xl flex-col items-center gap-4 px-6 py-24 text-center">
          <RefreshCw className="h-10 w-10 animate-spin text-emerald-600" />
          <h2 className="text-xl font-semibold">
            {stage.kind === "regenerating"
              ? "Updating your playbook…"
              : "Drafting your sales playbook…"}
          </h2>
          <p className="text-sm text-muted-foreground">
            Pulling everything you said into a complete playbook. This usually
            takes 20-40 seconds.
          </p>
        </div>
      </Shell>
    );
  }

  // ────────────────────────────────────────────────────────────────────
  // Playbook display + approve / feedback
  // ────────────────────────────────────────────────────────────────────
  if (stage.kind === "playbook" && playbook) {
    function approve() {
      if (
        !confirm(
          "Approve this playbook? It goes to Aylek for final sign-off, then your sales agents go live.",
        )
      )
        return;
      setError(null);
      start(async () => {
        const res = await fetch(`/api/onboarding/${props.token}/approve`, {
          method: "POST",
        });
        const json = (await res.json().catch(() => null)) as {
          ok: boolean;
          error?: string;
        } | null;
        if (!json?.ok) {
          setError(json?.error ?? "Failed to approve playbook.");
          return;
        }
        setStage({ kind: "approved" });
      });
    }
    function submitFeedback() {
      const fb = feedbackText.trim();
      if (fb.length < 5) {
        setError("Tell me what to change.");
        return;
      }
      setError(null);
      setWarning(null);
      setStage({ kind: "regenerating" });
      start(async () => {
        const res = await fetch(`/api/onboarding/${props.token}/feedback`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ feedback: fb }),
        });
        const json = (await res.json().catch(() => null)) as {
          ok: boolean;
          error?: string;
          playbook?: GeneratedPlaybookDraft;
          warning?: string | null;
          round?: number;
        } | null;
        if (!json?.ok || !json.playbook) {
          setError(json?.error ?? "Failed to regenerate playbook.");
          setStage({ kind: "playbook" });
          return;
        }
        if (json.warning) setWarning(json.warning);
        setPlaybook(json.playbook);
        setFeedbackRounds((r) => [
          ...r,
          {
            requested_at: new Date().toISOString(),
            feedback: fb,
            prior_playbook: null,
          },
        ]);
        setFeedbackText("");
        setFeedbackOpen(false);
        setStage({ kind: "playbook" });
      });
    }

    return (
      <Shell clientName={props.clientName}>
        <div className="mx-auto max-w-3xl px-6 py-10">
          <div className="mb-6 rounded-xl border border-emerald-200 bg-emerald-50 p-5">
            <div className="flex items-start gap-3">
              <Sparkles className="mt-0.5 h-5 w-5 shrink-0 text-emerald-700" />
              <div>
                <h1 className="text-lg font-semibold text-emerald-900">
                  Your playbook is ready, {props.clientName}.
                </h1>
                <p className="mt-1 text-sm text-emerald-900/80">
                  Read through the sections below. If something doesn&apos;t
                  match how you sell, request a change and I&apos;ll rewrite it.
                  When it looks right, approve and we&apos;ll send it to Aylek
                  for final sign-off.
                </p>
                {feedbackRounds.length > 0 && (
                  <p className="mt-2 text-xs text-emerald-900/70">
                    Round {feedbackRounds.length + 1} of revisions.
                  </p>
                )}
              </div>
            </div>
          </div>

          {warning && (
            <Alert className="mb-4 border-amber-300 bg-amber-50 text-amber-900">{warning}</Alert>
          )}
          {error && (
            <Alert variant="destructive" className="mb-4">
              {error}
            </Alert>
          )}

          <PlaybookView playbook={playbook} />

          <div className="mt-8 flex flex-col gap-3 rounded-xl border bg-card p-5 shadow-sm sm:flex-row sm:items-center sm:justify-between">
            <div className="text-sm text-muted-foreground">
              Happy with it, or want changes?
            </div>
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" onClick={() => setFeedbackOpen((v) => !v)}>
                <MessageSquare className="mr-1.5 h-3.5 w-3.5" /> Request changes
              </Button>
              <Button
                onClick={approve}
                disabled={pending}
                className="bg-emerald-600 text-white hover:bg-emerald-700"
              >
                <CheckCircle2 className="mr-1.5 h-3.5 w-3.5" />{" "}
                {pending ? "Submitting…" : "Approve playbook"}
              </Button>
            </div>
          </div>

          {feedbackOpen && (
            <div className="mt-4 rounded-xl border bg-card p-5 shadow-sm">
              <p className="text-sm font-medium">What should change?</p>
              <p className="mt-1 text-xs text-muted-foreground">
                Be specific — e.g. &quot;sequence step 2 is too pushy, soften
                it&quot; or &quot;ICP should also include logistics
                companies&quot;.
              </p>
              <Textarea
                value={feedbackText}
                onChange={(e) => setFeedbackText(e.target.value)}
                placeholder="Tell me what to change…"
                rows={4}
                className="mt-3"
                disabled={pending}
              />
              <div className="mt-3 flex justify-end gap-2">
                <Button variant="ghost" size="sm" onClick={() => setFeedbackOpen(false)}>
                  Cancel
                </Button>
                <Button
                  size="sm"
                  disabled={pending || feedbackText.trim().length < 5}
                  onClick={submitFeedback}
                >
                  <RefreshCw className="mr-1.5 h-3.5 w-3.5" /> Regenerate with
                  feedback
                </Button>
              </div>
            </div>
          )}
        </div>
      </Shell>
    );
  }

  // ────────────────────────────────────────────────────────────────────
  // Approved
  // ────────────────────────────────────────────────────────────────────
  return (
    <Shell clientName={props.clientName}>
      <div className="mx-auto flex max-w-xl flex-col items-center gap-4 px-6 py-24 text-center">
        <CheckCircle2 className="h-12 w-12 text-emerald-600" />
        <h2 className="text-2xl font-semibold">Approved — thanks!</h2>
        <p className="text-sm text-muted-foreground">
          Your playbook is with Aylek for final sign-off. We&apos;ll email you
          when your sales agents go live.
        </p>
      </div>
    </Shell>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Subcomponents
// ─────────────────────────────────────────────────────────────────────────

function Shell({
  clientName,
  children,
}: {
  clientName: string;
  children: React.ReactNode;
}) {
  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 via-emerald-50/40 to-slate-50">
      <header className="border-b bg-white/80 backdrop-blur">
        <div className="mx-auto flex max-w-3xl items-center justify-between px-6 py-3 text-sm">
          <span className="font-semibold tracking-tight">Aylek Sales</span>
          <span className="text-muted-foreground">
            Onboarding · <span className="text-foreground">{clientName}</span>
          </span>
        </div>
      </header>
      {children}
    </div>
  );
}

function ChatBubble({
  role,
  text,
  muted,
}: {
  role: "assistant" | "user";
  text: string;
  muted?: boolean;
}) {
  const isUser = role === "user";
  return (
    <div className={`flex ${isUser ? "justify-end" : "justify-start"}`}>
      <div
        className={`max-w-[85%] whitespace-pre-wrap rounded-2xl px-4 py-2.5 text-sm leading-relaxed ${
          isUser
            ? "bg-emerald-600 text-white"
            : "bg-muted text-foreground"
        } ${muted ? "opacity-50" : ""}`}
      >
        {text}
      </div>
    </div>
  );
}

function PlaybookView({ playbook }: { playbook: GeneratedPlaybookDraft }) {
  return (
    <div className="space-y-6">
      <Section title="ICP — who you sell to">
        <Field label="Industries" value={(playbook.icp.industries ?? []).join(", ")} />
        <Field label="Company size" value={playbook.icp.company_size ?? ""} />
        <Field
          label="Target titles"
          value={(playbook.icp.target_titles ?? []).join(", ")}
        />
        <Field label="Geography" value={(playbook.icp.geography ?? []).join(", ")} />
        <Field label="Qualification signal" value={playbook.icp.qualification_signal ?? ""} />
        {(playbook.icp.disqualifiers ?? []).length > 0 && (
          <Field label="Disqualifiers" value={(playbook.icp.disqualifiers ?? []).join("; ")} />
        )}
      </Section>

      <Section title="Strategy & messaging">
        <Field label="Value proposition" value={playbook.strategy.value_proposition ?? ""} />
        {(playbook.strategy.key_messages ?? []).length > 0 && (
          <List label="Key messages" items={playbook.strategy.key_messages ?? []} />
        )}
        {(playbook.strategy.proof_points ?? []).length > 0 && (
          <List label="Proof points" items={playbook.strategy.proof_points ?? []} />
        )}
        {(playbook.strategy.objection_responses ?? []).length > 0 && (
          <div className="space-y-2">
            <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
              Objection responses
            </p>
            <ul className="space-y-2 text-sm">
              {(playbook.strategy.objection_responses ?? []).map((o, i) => (
                <li key={i} className="rounded-md border bg-muted/30 p-3">
                  <p className="font-medium">{o.objection}</p>
                  <p className="mt-1 text-muted-foreground">{o.response}</p>
                </li>
              ))}
            </ul>
          </div>
        )}
      </Section>

      <Section title="Voice & tone">
        {(playbook.voice_tone.tone_descriptors ?? []).length > 0 && (
          <Field
            label="Tone descriptors"
            value={(playbook.voice_tone.tone_descriptors ?? []).join(", ")}
          />
        )}
        <Field label="Writing style" value={playbook.voice_tone.writing_style ?? ""} />
        {(playbook.voice_tone.avoid ?? []).length > 0 && (
          <Field label="Avoid" value={(playbook.voice_tone.avoid ?? []).join(", ")} />
        )}
        {(playbook.voice_tone.example_phrases ?? []).length > 0 && (
          <List
            label="Example phrases"
            items={playbook.voice_tone.example_phrases ?? []}
          />
        )}
      </Section>

      <Section title="Reply strategy">
        {Object.entries(playbook.reply_strategy ?? {}).map(([kind, val]) => (
          <div key={kind} className="rounded-md border bg-muted/30 p-3 text-sm">
            <p className="font-medium capitalize">{kind.replace(/_/g, " ")}</p>
            {val?.action && <p className="mt-1 text-muted-foreground">Action: {val.action}</p>}
            {val?.template && (
              <pre className="mt-2 whitespace-pre-wrap font-mono text-xs text-foreground/80">
                {val.template}
              </pre>
            )}
          </div>
        ))}
      </Section>

      <Section title="Sales team">
        {(playbook.team_members ?? []).length === 0 ? (
          <p className="text-sm text-muted-foreground">No team members listed.</p>
        ) : (
          <ul className="space-y-2 text-sm">
            {(playbook.team_members ?? []).map((m) => (
              <li key={m.id} className="rounded-md border bg-muted/30 p-3">
                <p className="font-medium">{m.name}</p>
                <p className="text-xs text-muted-foreground">
                  {m.title} · {m.email}
                </p>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title="Sales process">
        <ul className="space-y-2 text-sm">
          {(playbook.sales_process ?? []).map((s: SalesProcessStage, i: number) => (
            <li key={s.id} className="rounded-md border bg-muted/30 p-3">
              <div className="flex items-center justify-between gap-2">
                <p className="font-medium">
                  {i + 1}. {s.name}
                </p>
                <span className="rounded-full border bg-background px-2 py-0.5 text-[10px] uppercase tracking-wider text-muted-foreground">
                  {s.agent}
                </span>
              </div>
              <p className="mt-1 text-xs text-muted-foreground">{s.description}</p>
              {s.condition && (
                <p className="mt-1 rounded-md bg-amber-50 px-2 py-1 text-xs text-amber-900">
                  Condition: {s.condition}
                </p>
              )}
            </li>
          ))}
        </ul>
      </Section>

      <Section title="Email sequence">
        <ol className="space-y-3 text-sm">
          {(playbook.sequences ?? []).map((seq) => (
            <li key={seq.step} className="rounded-md border bg-muted/30 p-3">
              <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                Step {seq.step}{" "}
                {seq.delay_days > 0 ? `· +${seq.delay_days} days` : "· same day"}
              </p>
              <p className="mt-2 font-medium">{seq.subject}</p>
              <pre className="mt-2 whitespace-pre-wrap font-mono text-xs text-foreground/80">
                {seq.body}
              </pre>
            </li>
          ))}
        </ol>
      </Section>

      {playbook.notes && (
        <Section title="Notes from the AI">
          <p className="rounded-md bg-amber-50 p-3 text-sm text-amber-900">
            {playbook.notes}
          </p>
        </Section>
      )}
    </div>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-xl border bg-card p-5 shadow-sm">
      <h3 className="mb-3 text-base font-semibold">{title}</h3>
      <div className="space-y-3">{children}</div>
    </section>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  if (!value) return null;
  return (
    <div className="text-sm">
      <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
        {label}
      </p>
      <p className="mt-0.5">{value}</p>
    </div>
  );
}

function List({ label, items }: { label: string; items: string[] }) {
  if (items.length === 0) return null;
  return (
    <div className="text-sm">
      <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
        {label}
      </p>
      <ul className="mt-1 list-inside list-disc space-y-1">
        {items.map((it, i) => (
          <li key={i}>{it}</li>
        ))}
      </ul>
    </div>
  );
}
