"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Alert } from "@/components/ui/alert";
import {
  ArrowRight,
  CheckCircle2,
  MessageSquare,
  RefreshCw,
  Sparkles,
} from "lucide-react";
import type {
  CoreTopic,
  NextQuestion,
} from "@/lib/onboarding";
import type {
  GeneratedPlaybookDraft,
  OnboardingAnswers,
  OnboardingFeedbackRound,
  OnboardingSectionId,
  OnboardingStatus,
  PlaybookSequenceStep,
  SalesProcessStage,
} from "@/lib/supabase/types";

// ─────────────────────────────────────────────────────────────────────────
// Stage machine + section schema
// ─────────────────────────────────────────────────────────────────────────

type Stage =
  | { kind: "welcome" }
  | { kind: "interview" }
  | { kind: "generating" }
  | { kind: "review"; sectionIdx: number }
  | { kind: "submitting" }
  | { kind: "approved" };

const SECTIONS: Array<{ id: OnboardingSectionId; label: string }> = [
  { id: "icp", label: "Ideal Customer Profile" },
  { id: "strategy", label: "Strategy & Key Messaging" },
  { id: "voice_tone", label: "Voice & Tone" },
  { id: "sequences", label: "Email Sequence" },
  { id: "sales_process", label: "Sales Process" },
];

// ─────────────────────────────────────────────────────────────────────────
// Main component
// ─────────────────────────────────────────────────────────────────────────

export function OnboardingClient(props: {
  token: string;
  clientName: string;
  initialStatus: OnboardingStatus;
  initialAnswers: OnboardingAnswers;
  initialPlaybook: GeneratedPlaybookDraft | null;
  initialFeedbackRounds: OnboardingFeedbackRound[];
  initialQuestion: NextQuestion | null;
  initialSectionApprovals: Partial<Record<OnboardingSectionId, boolean>>;
  coreTopics: CoreTopic[];
}) {
  // Approval state — hydrated from server
  const [sectionApprovals, setSectionApprovals] = useState<
    Partial<Record<OnboardingSectionId, boolean>>
  >(props.initialSectionApprovals);

  // Pick initial stage:
  //  - approved → done screen
  //  - playbook_generated → resume on first un-approved section
  //  - has answers → interview
  //  - else → welcome
  const initialStage: Stage = (() => {
    if (props.initialStatus === "approved") return { kind: "approved" };
    if (props.initialStatus === "playbook_generated" || props.initialPlaybook) {
      const firstUnapproved = SECTIONS.findIndex(
        (s) => props.initialSectionApprovals[s.id] !== true,
      );
      return { kind: "review", sectionIdx: firstUnapproved < 0 ? 0 : firstUnapproved };
    }
    if ((props.initialAnswers.questions ?? []).length === 0) return { kind: "welcome" };
    return { kind: "interview" };
  })();

  const [stage, setStage] = useState<Stage>(initialStage);
  const [currentQ, setCurrentQ] = useState<NextQuestion | null>(props.initialQuestion);
  const [draftAnswer, setDraftAnswer] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const [playbook, setPlaybook] = useState<GeneratedPlaybookDraft | null>(props.initialPlaybook);
  const [feedbackRounds, setFeedbackRounds] = useState<OnboardingFeedbackRound[]>(
    props.initialFeedbackRounds,
  );

  // Track number of answered turns for the progress dots
  const answeredCount = (props.initialAnswers.questions ?? []).length;
  const [turnCount, setTurnCount] = useState<number>(answeredCount);

  // Slide animation key — bump on every transition to retrigger fade-in.
  const [slideKey, setSlideKey] = useState(0);

  // Per-section feedback UI state
  const [feedbackSection, setFeedbackSection] = useState<OnboardingSectionId | null>(null);
  const [feedbackText, setFeedbackText] = useState("");
  const [sectionRegenerating, setSectionRegenerating] = useState<OnboardingSectionId | null>(null);

  function bumpSlide() {
    setSlideKey((k) => k + 1);
  }

  // ───────────────────────────────────────────────────────────────────
  // Welcome
  // ───────────────────────────────────────────────────────────────────
  if (stage.kind === "welcome") {
    return (
      <Shell>
        <SlideContainer slideKey={slideKey}>
          <div className="mx-auto flex w-full max-w-2xl flex-col items-start gap-8">
            <Sparkles className="h-8 w-8 text-primary" />
            <h1 className="text-5xl font-semibold tracking-tight text-foreground">
              Welcome, {props.clientName}.
            </h1>
            <p className="text-lg text-muted-foreground">
              I&apos;ll ask you 8 quick questions about your business and how
              you sell — should take about 15 minutes. Then I&apos;ll draft your
              full sales playbook and you can review it section by section
              before anything goes live.
            </p>
            <Button
              size="lg"
              onClick={() => {
                setStage({ kind: "interview" });
                bumpSlide();
              }}
              className="mt-2"
            >
              Start the interview <ArrowRight className="ml-2 h-4 w-4" />
            </Button>
          </div>
        </SlideContainer>
      </Shell>
    );
  }

  // ───────────────────────────────────────────────────────────────────
  // Interview — one question per slide
  // ───────────────────────────────────────────────────────────────────
  if (stage.kind === "interview") {
    function submitAnswer() {
      if (!currentQ) return;
      const ans = draftAnswer.trim();
      if (ans.length === 0) {
        setError("Type something before sending.");
        return;
      }
      setError(null);
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
        setCurrentQ(json.next_question);
        setDraftAnswer("");
        setTurnCount((n) => n + 1);
        bumpSlide();
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
      setStage({ kind: "generating" });
      bumpSlide();
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
        } | null;
        if (!json?.ok || !json.playbook) {
          setError(json?.error ?? "Failed to generate playbook.");
          setStage({ kind: "interview" });
          return;
        }
        setPlaybook(json.playbook);
        setStage({ kind: "review", sectionIdx: 0 });
        bumpSlide();
      });
    }

    const total = props.coreTopics.length;
    // Each answered turn moves us forward; the current question fills slot
    // (turnCount + 1).
    const currentSlot = Math.min(turnCount + 1, total);

    return (
      <Shell>
        <ProgressDots current={currentSlot} total={total} />
        <SlideContainer slideKey={slideKey}>
          <div className="mx-auto flex w-full max-w-3xl flex-col gap-8">
            <p className="text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">
              Question {currentSlot} of {total}
            </p>
            <h2 className="text-3xl font-semibold leading-tight tracking-tight text-foreground sm:text-4xl">
              {currentQ?.question ?? "…"}
            </h2>
            <Textarea
              value={draftAnswer}
              onChange={(e) => setDraftAnswer(e.target.value)}
              placeholder="Type your answer…"
              rows={6}
              autoFocus
              disabled={pending}
              className="resize-none text-base leading-relaxed"
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  submitAnswer();
                }
              }}
            />
            {error && (
              <Alert variant="destructive">
                {error}
              </Alert>
            )}
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="text-xs text-muted-foreground">
                Enter to send · Shift + Enter for a new line
              </p>
              <div className="flex items-center gap-2">
                {currentQ?.ready_to_complete && (
                  <Button
                    type="button"
                    variant="outline"
                    onClick={imDone}
                    disabled={pending}
                  >
                    <CheckCircle2 className="mr-1.5 h-4 w-4" /> I&apos;m done
                  </Button>
                )}
                <Button onClick={submitAnswer} disabled={pending || !draftAnswer.trim()}>
                  {pending ? "Saving…" : "Next"}
                  <ArrowRight className="ml-1.5 h-4 w-4" />
                </Button>
              </div>
            </div>
          </div>
        </SlideContainer>
      </Shell>
    );
  }

  // ───────────────────────────────────────────────────────────────────
  // Generating
  // ───────────────────────────────────────────────────────────────────
  if (stage.kind === "generating") {
    return (
      <Shell>
        <SlideContainer slideKey={slideKey}>
          <div className="mx-auto flex max-w-xl flex-col items-center gap-6 text-center">
            <RefreshCw className="h-10 w-10 animate-spin text-primary" />
            <h2 className="text-2xl font-semibold tracking-tight">
              Drafting your sales playbook…
            </h2>
            <p className="text-sm text-muted-foreground">
              Pulling everything you said into a complete playbook custom-built
              for {props.clientName}. Usually 20-40 seconds.
            </p>
          </div>
        </SlideContainer>
      </Shell>
    );
  }

  // ───────────────────────────────────────────────────────────────────
  // Submitting (final) / Approved
  // ───────────────────────────────────────────────────────────────────
  if (stage.kind === "submitting") {
    return (
      <Shell>
        <SlideContainer slideKey={slideKey}>
          <div className="mx-auto flex max-w-xl flex-col items-center gap-6 text-center">
            <RefreshCw className="h-10 w-10 animate-spin text-primary" />
            <h2 className="text-2xl font-semibold tracking-tight">Submitting to Aylek…</h2>
            <p className="text-sm text-muted-foreground">Almost there.</p>
          </div>
        </SlideContainer>
      </Shell>
    );
  }
  if (stage.kind === "approved") {
    return (
      <Shell>
        <SlideContainer slideKey={slideKey}>
          <div className="mx-auto flex max-w-xl flex-col items-center gap-6 text-center">
            <CheckCircle2 className="h-12 w-12 text-primary" />
            <h2 className="text-3xl font-semibold tracking-tight">Approved — thanks!</h2>
            <p className="text-base text-muted-foreground">
              Your playbook is with Aylek for final sign-off. We&apos;ll email
              you when your sales agents go live.
            </p>
          </div>
        </SlideContainer>
      </Shell>
    );
  }

  // ───────────────────────────────────────────────────────────────────
  // Section-by-section review
  // ───────────────────────────────────────────────────────────────────
  if (stage.kind === "review" && playbook) {
    const sectionIdx = stage.sectionIdx; // capture for closures
    const section = SECTIONS[sectionIdx];
    const isLast = sectionIdx === SECTIONS.length - 1;
    const isApproved = sectionApprovals[section.id] === true;
    const isFeedbackOpen = feedbackSection === section.id;
    const isRegenerating = sectionRegenerating === section.id;

    function submitSectionFeedback() {
      const fb = feedbackText.trim();
      if (fb.length < 5) {
        setError("Tell me what to change.");
        return;
      }
      setError(null);
      setSectionRegenerating(section.id);
      start(async () => {
        const res = await fetch(`/api/onboarding/${props.token}/feedback`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ feedback: fb, section: section.id }),
        });
        const json = (await res.json().catch(() => null)) as {
          ok: boolean;
          error?: string;
          section?: OnboardingSectionId;
          content?: unknown;
          round?: number;
        } | null;
        setSectionRegenerating(null);
        if (!json?.ok || !json.section || json.content == null) {
          setError(json?.error ?? "Failed to revise the section.");
          return;
        }
        // Replace the section content + reset the approval flag locally
        setPlaybook((pb) => (pb ? { ...pb, [section.id]: json.content } as GeneratedPlaybookDraft : pb));
        setSectionApprovals((a) => ({ ...a, [section.id]: false }));
        setFeedbackRounds((r) => [
          ...r,
          {
            requested_at: new Date().toISOString(),
            feedback: fb,
            section: section.id,
            prior_section: null,
            prior_playbook: null,
          },
        ]);
        setFeedbackText("");
        setFeedbackSection(null);
      });
    }

    function approveSection() {
      setError(null);
      start(async () => {
        const res = await fetch(`/api/onboarding/${props.token}/approve-section`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ section: section.id }),
        });
        const json = (await res.json().catch(() => null)) as {
          ok: boolean;
          error?: string;
          section_approvals?: Partial<Record<OnboardingSectionId, boolean>>;
        } | null;
        if (!json?.ok) {
          setError(json?.error ?? "Failed to approve section.");
          return;
        }
        setSectionApprovals(json.section_approvals ?? sectionApprovals);
        if (isLast) {
          // All sections now approved — submit to HOS
          submitFinal();
        } else {
          setStage({ kind: "review", sectionIdx: sectionIdx + 1 });
          bumpSlide();
        }
      });
    }

    function submitFinal() {
      setStage({ kind: "submitting" });
      bumpSlide();
      start(async () => {
        const res = await fetch(`/api/onboarding/${props.token}/approve`, {
          method: "POST",
        });
        const json = (await res.json().catch(() => null)) as {
          ok: boolean;
          error?: string;
        } | null;
        if (!json?.ok) {
          setError(json?.error ?? "Failed to submit playbook.");
          // Bounce back to the last section so they can retry
          setStage({ kind: "review", sectionIdx: SECTIONS.length - 1 });
          return;
        }
        setStage({ kind: "approved" });
        bumpSlide();
      });
    }

    return (
      <Shell>
        <SectionProgress
          current={stage.sectionIdx + 1}
          total={SECTIONS.length}
          label={section.label}
        />
        <SlideContainer slideKey={slideKey}>
          <div className="mx-auto flex w-full max-w-3xl flex-col gap-6">
            <div>
              <p className="text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">
                Section {stage.sectionIdx + 1} of {SECTIONS.length}
              </p>
              <h2 className="mt-1 text-3xl font-semibold tracking-tight">
                {section.label}
              </h2>
              <p className="mt-2 text-sm text-muted-foreground">
                {sectionIntro(section.id, props.clientName)}
              </p>
            </div>

            <div className="relative rounded-2xl border bg-card p-6 shadow-sm">
              {isRegenerating && (
                <div className="absolute inset-0 z-10 flex items-center justify-center rounded-2xl bg-card/80 backdrop-blur-sm">
                  <div className="flex flex-col items-center gap-2 text-sm text-muted-foreground">
                    <RefreshCw className="h-6 w-6 animate-spin text-primary" />
                    Updating this section…
                  </div>
                </div>
              )}
              <SectionView section={section.id} playbook={playbook} />
            </div>

            {error && (
              <Alert variant="destructive">{error}</Alert>
            )}

            {isFeedbackOpen ? (
              <div className="rounded-2xl border bg-card p-5 shadow-sm">
                <p className="text-sm font-medium">What should change in this section?</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  Be specific — e.g. &quot;ICP should also include logistics
                  companies&quot; or &quot;step 2 is too pushy, soften it&quot;.
                  Only this section will be rewritten.
                </p>
                <Textarea
                  value={feedbackText}
                  onChange={(e) => setFeedbackText(e.target.value)}
                  rows={5}
                  className="mt-3 resize-none"
                  placeholder="Tell me what to change…"
                  autoFocus
                  disabled={pending || isRegenerating}
                />
                <div className="mt-3 flex justify-end gap-2">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      setFeedbackSection(null);
                      setFeedbackText("");
                    }}
                    disabled={pending || isRegenerating}
                  >
                    Cancel
                  </Button>
                  <Button
                    size="sm"
                    onClick={submitSectionFeedback}
                    disabled={pending || isRegenerating || feedbackText.trim().length < 5}
                  >
                    <RefreshCw className="mr-1.5 h-3.5 w-3.5" /> Submit feedback
                  </Button>
                </div>
              </div>
            ) : (
              <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border bg-card p-5 shadow-sm">
                <p className="text-sm text-muted-foreground">
                  {isApproved
                    ? "Approved. You can still request more changes if anything looks off."
                    : "Read it through. Approve to move on, or give feedback to revise just this section."}
                </p>
                <div className="flex flex-wrap gap-2">
                  <Button
                    variant="outline"
                    onClick={() => {
                      setFeedbackSection(section.id);
                      setError(null);
                    }}
                    disabled={pending || isRegenerating}
                  >
                    <MessageSquare className="mr-1.5 h-4 w-4" /> Give feedback
                  </Button>
                  <Button
                    onClick={approveSection}
                    disabled={pending || isRegenerating}
                  >
                    <CheckCircle2 className="mr-1.5 h-4 w-4" />
                    {isLast
                      ? pending
                        ? "Submitting…"
                        : "Approve & submit playbook"
                      : pending
                        ? "Approving…"
                        : "Approve & continue"}
                  </Button>
                </div>
              </div>
            )}

            {feedbackRounds.length > 0 && (
              <p className="text-center text-xs text-muted-foreground">
                {feedbackRounds.length} revision{feedbackRounds.length === 1 ? "" : "s"} so far
              </p>
            )}
          </div>
        </SlideContainer>
      </Shell>
    );
  }

  return null;
}

// ─────────────────────────────────────────────────────────────────────────
// Layout primitives
// ─────────────────────────────────────────────────────────────────────────

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="dark min-h-screen bg-background text-foreground">
      <div className="absolute inset-0 -z-10 bg-[radial-gradient(ellipse_at_top,_hsl(160_84%_39%/0.08),_transparent_60%)]" />
      <header className="border-b border-border/40 bg-background/60 backdrop-blur">
        <div className="mx-auto flex max-w-5xl items-center justify-between px-6 py-4">
          <div className="flex items-center gap-2">
            <div className="h-2 w-2 rounded-full bg-primary" />
            <span className="text-sm font-semibold tracking-tight">
              Aylek <span className="text-muted-foreground">Sales</span>
            </span>
          </div>
          <span className="text-xs text-muted-foreground">Onboarding interview</span>
        </div>
      </header>
      <main className="mx-auto max-w-5xl px-6 py-12 sm:py-20">{children}</main>
    </div>
  );
}

function SlideContainer({
  slideKey,
  children,
}: {
  slideKey: number;
  children: React.ReactNode;
}) {
  // Re-mount on key change for a clean fade-in transition.
  const [visible, setVisible] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    setVisible(false);
    const t = setTimeout(() => setVisible(true), 20);
    return () => clearTimeout(t);
  }, [slideKey]);

  return (
    <div
      ref={ref}
      key={slideKey}
      className={`transform-gpu transition-all duration-300 ease-out ${
        visible ? "translate-y-0 opacity-100" : "translate-y-3 opacity-0"
      }`}
    >
      {children}
    </div>
  );
}

function ProgressDots({ current, total }: { current: number; total: number }) {
  return (
    <div className="mx-auto mb-10 flex max-w-3xl items-center gap-1.5">
      {Array.from({ length: total }, (_, i) => {
        const slot = i + 1;
        const isCurrent = slot === current;
        const isCompleted = slot < current;
        return (
          <span
            key={i}
            className={`h-1.5 flex-1 rounded-full transition-colors ${
              isCompleted
                ? "bg-primary"
                : isCurrent
                  ? "bg-primary/60"
                  : "bg-muted"
            }`}
          />
        );
      })}
    </div>
  );
}

function SectionProgress({
  current,
  total,
  label,
}: {
  current: number;
  total: number;
  label: string;
}) {
  return (
    <div className="mx-auto mb-10 flex max-w-3xl items-center justify-between">
      <p className="text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">
        {label}
      </p>
      <div className="flex items-center gap-1.5">
        {Array.from({ length: total }, (_, i) => {
          const slot = i + 1;
          const isCurrent = slot === current;
          const isCompleted = slot < current;
          return (
            <span
              key={i}
              className={`h-2 w-2 rounded-full transition-colors ${
                isCompleted ? "bg-primary" : isCurrent ? "bg-primary" : "bg-muted ring-1 ring-border"
              }`}
            />
          );
        })}
        <span className="ml-2 text-xs text-muted-foreground">
          {current} / {total}
        </span>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Per-section views
// ─────────────────────────────────────────────────────────────────────────

function sectionIntro(s: OnboardingSectionId, clientName: string): string {
  switch (s) {
    case "icp":
      return `The exact customer profile your agents will source against. Drawn from how you described ${clientName}'s best-fit buyers.`;
    case "strategy":
      return `Your value proposition, the messages that land, and how to handle the objections you actually hear.`;
    case "voice_tone":
      return `How your team writes — what to do, what to avoid, and how it should feel to read.`;
    case "sequences":
      return `The 3-step outbound email sequence your agents will run. Written in your voice for your buyers.`;
    case "sales_process":
      return `The full lifecycle — who owns each stage and the conditions that gate them.`;
  }
}

function SectionView({
  section,
  playbook,
}: {
  section: OnboardingSectionId;
  playbook: GeneratedPlaybookDraft;
}) {
  switch (section) {
    case "icp":
      return <IcpView icp={playbook.icp} />;
    case "strategy":
      return <StrategyView strategy={playbook.strategy} />;
    case "voice_tone":
      return <VoiceToneView voice={playbook.voice_tone} />;
    case "sequences":
      return <SequencesView sequences={playbook.sequences} />;
    case "sales_process":
      return <SalesProcessView stages={playbook.sales_process} />;
  }
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
  if (!items || items.length === 0) return null;
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

function IcpView({ icp }: { icp: GeneratedPlaybookDraft["icp"] }) {
  return (
    <div className="space-y-4">
      <Field label="Industries" value={(icp.industries ?? []).join(", ")} />
      <Field label="Company size" value={icp.company_size ?? ""} />
      <Field label="Target titles" value={(icp.target_titles ?? []).join(", ")} />
      <Field label="Geography" value={(icp.geography ?? []).join(", ")} />
      <Field label="Qualification signal" value={icp.qualification_signal ?? ""} />
      {(icp.disqualifiers ?? []).length > 0 && (
        <Field label="Disqualifiers" value={(icp.disqualifiers ?? []).join("; ")} />
      )}
    </div>
  );
}

function StrategyView({
  strategy,
}: {
  strategy: GeneratedPlaybookDraft["strategy"];
}) {
  return (
    <div className="space-y-4">
      <Field label="Value proposition" value={strategy.value_proposition ?? ""} />
      <List label="Key messages" items={strategy.key_messages ?? []} />
      <List label="Proof points" items={strategy.proof_points ?? []} />
      {(strategy.objection_responses ?? []).length > 0 && (
        <div className="space-y-2">
          <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
            Objection responses
          </p>
          <ul className="space-y-2 text-sm">
            {(strategy.objection_responses ?? []).map((o, i) => (
              <li key={i} className="rounded-md border border-border/60 bg-background/40 p-3">
                <p className="font-medium">{o.objection}</p>
                <p className="mt-1 text-muted-foreground">{o.response}</p>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function VoiceToneView({
  voice,
}: {
  voice: GeneratedPlaybookDraft["voice_tone"];
}) {
  return (
    <div className="space-y-4">
      <Field
        label="Tone descriptors"
        value={(voice.tone_descriptors ?? []).join(", ")}
      />
      <Field label="Writing style" value={voice.writing_style ?? ""} />
      <Field label="Avoid" value={(voice.avoid ?? []).join(", ")} />
      <List label="Example phrases" items={voice.example_phrases ?? []} />
    </div>
  );
}

function SequencesView({
  sequences,
}: {
  sequences: PlaybookSequenceStep[];
}) {
  if (!sequences || sequences.length === 0) {
    return <p className="text-sm text-muted-foreground">No sequence yet.</p>;
  }
  return (
    <ol className="space-y-4 text-sm">
      {sequences.map((seq) => (
        <li
          key={seq.step}
          className="rounded-lg border border-border/60 bg-background/40 p-4"
        >
          <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
            Step {seq.step}{" "}
            {seq.delay_days > 0 ? `· +${seq.delay_days} days` : "· same day"}
          </p>
          <p className="mt-2 font-medium">{seq.subject}</p>
          <pre className="mt-2 whitespace-pre-wrap font-mono text-xs leading-relaxed text-foreground/90">
            {seq.body}
          </pre>
        </li>
      ))}
    </ol>
  );
}

function SalesProcessView({
  stages,
}: {
  stages: SalesProcessStage[];
}) {
  if (!stages || stages.length === 0) {
    return <p className="text-sm text-muted-foreground">No process yet.</p>;
  }
  return (
    <ul className="space-y-3 text-sm">
      {stages.map((s, i) => (
        <li key={s.id} className="rounded-lg border border-border/60 bg-background/40 p-3">
          <div className="flex items-center justify-between gap-2">
            <p className="font-medium">
              {i + 1}. {s.name}
            </p>
            <span className="rounded-full border border-border/60 bg-background/60 px-2 py-0.5 text-[10px] uppercase tracking-wider text-muted-foreground">
              {s.agent}
            </span>
          </div>
          <p className="mt-1 text-xs text-muted-foreground">{s.description}</p>
          {s.condition && (
            <p className="mt-2 rounded-md bg-primary/10 px-2 py-1 text-xs text-primary-foreground/90">
              Condition: {s.condition}
            </p>
          )}
        </li>
      ))}
    </ul>
  );
}
