"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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
  PlaybookSegment,
  PlaybookSequenceStep,
  SalesProcessStage,
} from "@/lib/supabase/types";

// ─────────────────────────────────────────────────────────────────────────
// Stage machine + section schema
// ─────────────────────────────────────────────────────────────────────────

type Stage =
  | { kind: "intro" }
  | { kind: "welcome" }
  | { kind: "interview" }
  | { kind: "generating" }
  | { kind: "review"; sectionIdx: number }
  | { kind: "submitting" }
  | { kind: "approved" };

// Client-facing labels — no internal jargon. Section ids stay the same
// for API + DB consistency.
const SECTIONS: Array<{ id: OnboardingSectionId; label: string }> = [
  { id: "icp", label: "Your ideal customer" },
  { id: "segments", label: "Your target segments" },
  { id: "strategy", label: "Your sales approach" },
  { id: "voice_tone", label: "How you communicate" },
  { id: "sequences", label: "Your outreach emails" },
  { id: "sales_process", label: "Your sales process" },
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
  // Contact-supplied display state. The intro slide writes both of these.
  // Until then the welcome screen / Claude prompts use placeholders (the
  // client-facing UI never shows the internal clients.name).
  const [contactName, setContactName] = useState<string>(
    props.initialAnswers.contact_name ?? "",
  );
  const [companyName, setCompanyName] = useState<string>(
    props.initialAnswers.company_name ?? "",
  );

  // Approval state — hydrated from server
  const [sectionApprovals, setSectionApprovals] = useState<
    Partial<Record<OnboardingSectionId, boolean>>
  >(props.initialSectionApprovals);

  // Pick initial stage:
  //  - approved → done screen
  //  - playbook_generated → resume on first un-approved section
  //  - no contact_name → intro (collect first name + company)
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
    if (!props.initialAnswers.contact_name || !props.initialAnswers.company_name) {
      return { kind: "intro" };
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

  // The display name shown anywhere on the public page. Falls back to the
  // server-supplied placeholder ONLY before the contact has done the
  // intro slide; after that the contact-supplied value wins everywhere.
  const displayCompanyName = (companyName || props.clientName).trim();

  // ───────────────────────────────────────────────────────────────────
  // Intro — collect first name + company name (always first slide)
  // ───────────────────────────────────────────────────────────────────
  if (stage.kind === "intro") {
    function submitIntro() {
      const fn = contactName.trim();
      const cn = companyName.trim();
      if (!fn || !cn) {
        setError("Both fields are required.");
        return;
      }
      setError(null);
      start(async () => {
        const res = await fetch(`/api/onboarding/${props.token}/intro`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ contact_name: fn, company_name: cn }),
        });
        const json = (await res.json().catch(() => null)) as {
          ok: boolean;
          error?: string;
          contact_name?: string;
          company_name?: string;
        } | null;
        if (!json?.ok) {
          setError(json?.error ?? "Couldn't save your details.");
          return;
        }
        if (json.contact_name) setContactName(json.contact_name);
        if (json.company_name) setCompanyName(json.company_name);
        setStage({ kind: "welcome" });
        bumpSlide();
      });
    }
    return (
      <Shell>
        <SlideContainer slideKey={slideKey}>
          <div className="mx-auto flex w-full max-w-xl flex-col gap-8">
            <Sparkles className="h-8 w-8 text-primary" />
            <h1 className="text-4xl font-semibold tracking-tight text-foreground sm:text-5xl">
              Let&apos;s get started.
            </h1>
            <p className="text-base text-muted-foreground">
              First — who are you, and what should we call your company?
            </p>
            <div className="space-y-4">
              <div>
                <label className="mb-2 block text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">
                  Your first name
                </label>
                <Input
                  value={contactName}
                  onChange={(e) => setContactName(e.target.value)}
                  placeholder="Sam"
                  autoFocus
                  className="h-12 text-base"
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      submitIntro();
                    }
                  }}
                />
              </div>
              <div>
                <label className="mb-2 block text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">
                  Your company name
                </label>
                <Input
                  value={companyName}
                  onChange={(e) => setCompanyName(e.target.value)}
                  placeholder="Acme Hospitality"
                  className="h-12 text-base"
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      submitIntro();
                    }
                  }}
                />
              </div>
            </div>
            {error && <Alert variant="destructive">{error}</Alert>}
            <div className="flex justify-end">
              <Button
                size="lg"
                onClick={submitIntro}
                disabled={pending || !contactName.trim() || !companyName.trim()}
              >
                {pending ? "Saving…" : "Continue"} <ArrowRight className="ml-2 h-4 w-4" />
              </Button>
            </div>
          </div>
        </SlideContainer>
      </Shell>
    );
  }

  // ───────────────────────────────────────────────────────────────────
  // Welcome — short, premium, no fixed-step disclosure
  // ───────────────────────────────────────────────────────────────────
  if (stage.kind === "welcome") {
    const greetName = contactName.trim();
    return (
      <Shell>
        <SlideContainer slideKey={slideKey}>
          <div className="mx-auto flex w-full max-w-2xl flex-col items-start gap-8">
            <Sparkles className="h-8 w-8 text-primary" />
            <h1 className="text-5xl font-semibold tracking-tight text-foreground">
              {greetName ? `Welcome, ${greetName}.` : "Welcome."}
            </h1>
            <p className="text-lg text-muted-foreground">
              Next up: a short conversation about {displayCompanyName} — how
              you sell, who you sell to, and how you talk. Take your time on
              each answer. When we&apos;re done, I&apos;ll put together the
              full setup and walk you through it before anything goes live.
            </p>
            <Button
              size="lg"
              onClick={() => {
                setStage({ kind: "interview" });
                bumpSlide();
              }}
              className="mt-2"
            >
              Let&apos;s begin <ArrowRight className="ml-2 h-4 w-4" />
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
          "Done? I'll put your sales setup together now — takes about 30 seconds.",
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
          setError(json?.error ?? "Couldn't put it together — please try again.");
          setStage({ kind: "interview" });
          return;
        }
        setPlaybook(json.playbook);
        setStage({ kind: "review", sectionIdx: 0 });
        bumpSlide();
      });
    }

    return (
      <Shell>
        <SlideContainer slideKey={slideKey}>
          <div className="mx-auto flex w-full max-w-3xl flex-col gap-8">
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
              Putting your sales setup together…
            </h2>
            <p className="text-sm text-muted-foreground">
              Pulling everything you said into a complete setup custom-built
              for {displayCompanyName}. Usually 20-40 seconds.
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
            <h2 className="text-2xl font-semibold tracking-tight">Sending it through…</h2>
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
              Your setup is with the Aylek team for a final review. We&apos;ll
              email you the moment everything goes live.
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
      console.log("[onboarding] submitting section feedback", {
        section: section.id,
        feedback_chars: fb.length,
      });
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
        console.log("[onboarding] section feedback response", json);
        if (!json?.ok || !json.section || json.content == null) {
          setError(json?.error ?? "Couldn't revise the section. Please try again.");
          return;
        }
        // Replace the section content + reset the approval flag locally.
        // Bump the slide key so the section card visibly fades back in
        // with the new content — a subtle but important UX signal.
        setPlaybook((pb) => {
          if (!pb) return pb;
          const next = { ...pb, [section.id]: json.content } as GeneratedPlaybookDraft;
          console.log("[onboarding] playbook updated for section", section.id, {
            content_changed: JSON.stringify(pb[section.id]) !== JSON.stringify(json.content),
          });
          return next;
        });
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
        bumpSlide();
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
          setError(json?.error ?? "Couldn't send it through — please try again.");
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
                {sectionIntro(section.id, displayCompanyName)}
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
              <SectionView
                section={section.id}
                playbook={playbook}
                token={props.token}
                onSegmentsChange={(segments) =>
                  setPlaybook((pb) => (pb ? { ...pb, segments } : pb))
                }
              />
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
                        ? "Sending it through…"
                        : "Approve & finish setup"
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

function sectionIntro(s: OnboardingSectionId, companyName: string): string {
  switch (s) {
    case "icp":
      return `The customers we'll go after for ${companyName} — industries, company types, and the people we'll reach out to inside them.`;
    case "segments":
      return `Your broad ICP, sliced into focused micro-segments. Each one gets its own pitch and its own outreach run. Approve the ones you want us to chase first; reject anything that's a wrong fit.`;
    case "strategy":
      return `Your value proposition, the messages that land, and how to handle the objections you actually hear.`;
    case "voice_tone":
      return `How your team writes — what to do, what to avoid, and how it should feel to read.`;
    case "sequences":
      return `The 3-step outbound email sequence we'll send for ${companyName}, written in your voice for your buyers.`;
    case "sales_process":
      return `The end-to-end path from a new lead to a closed deal, with any rules you want us to follow at each stage.`;
  }
}

function SectionView({
  section,
  playbook,
  token,
  onSegmentsChange,
}: {
  section: OnboardingSectionId;
  playbook: GeneratedPlaybookDraft;
  token: string;
  onSegmentsChange: (segments: PlaybookSegment[]) => void;
}) {
  switch (section) {
    case "icp":
      return <IcpView icp={playbook.icp} />;
    case "segments":
      return (
        <SegmentsView
          segments={playbook.segments ?? []}
          token={token}
          onChange={onSegmentsChange}
        />
      );
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

/**
 * Item 7 — segment review. Renders one card per segment with name +
 * description + value_angle + per-segment ICP highlights + a pool-size
 * badge + approve/reject buttons. The buttons hit
 * `/api/onboarding/[token]/segment-status` so the in-flight session
 * remembers the contact's choices; the eventual whole-playbook write
 * filters out rejected segments.
 *
 * The "Approve & continue" button on the parent section card is NOT
 * gated on every segment being decided (per master brief refinement).
 * Anything left at `pending_approval` writes through and HOS can flip
 * it later from the playbook editor.
 */
function SegmentsView({
  segments,
  token,
  onChange,
}: {
  segments: PlaybookSegment[];
  token: string;
  onChange: (next: PlaybookSegment[]) => void;
}) {
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (segments.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No segments were generated. You can keep going — Prospect-01 will fall
        back to the broader ICP for now and we&apos;ll build segments after
        we&apos;ve seen the first results.
      </p>
    );
  }

  async function flip(seg: PlaybookSegment, status: "active" | "rejected") {
    setError(null);
    setPendingId(seg.id);
    try {
      const res = await fetch(`/api/onboarding/${token}/segment-status`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ segment_id: seg.id, status }),
      });
      const json = (await res.json().catch(() => null)) as {
        ok: boolean;
        error?: string;
        segments?: PlaybookSegment[];
      } | null;
      if (!json?.ok || !json.segments) {
        setError(json?.error ?? "Failed to update segment. Please try again.");
        return;
      }
      onChange(json.segments);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setPendingId(null);
    }
  }

  const counts = segments.reduce(
    (acc, s) => {
      acc[s.status] = (acc[s.status] ?? 0) + 1;
      return acc;
    },
    {} as Record<string, number>,
  );

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
        <span>
          <strong className="text-foreground">{segments.length}</strong> segments
        </span>
        {counts.active ? <span>· {counts.active} active</span> : null}
        {counts.rejected ? <span>· {counts.rejected} rejected</span> : null}
        {counts.pending_approval ? (
          <span>· {counts.pending_approval} not yet decided</span>
        ) : null}
      </div>

      {error && <Alert variant="destructive">{error}</Alert>}

      <ul className="space-y-3">
        {segments.map((seg) => {
          const isPending = pendingId === seg.id;
          const isRejected = seg.status === "rejected";
          const isActive = seg.status === "active";
          return (
            <li
              key={seg.id}
              className={`rounded-lg border p-4 transition-colors ${
                isRejected
                  ? "border-border/60 bg-muted/30 opacity-70"
                  : isActive
                    ? "border-emerald-300 bg-emerald-50/40"
                    : "border-border/60 bg-background/40"
              }`}
            >
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <p className="font-medium">{seg.name}</p>
                  {seg.description && (
                    <p className="mt-0.5 text-sm text-muted-foreground">
                      {seg.description}
                    </p>
                  )}
                </div>
                <span className="shrink-0 rounded-full border border-border/70 bg-background px-2 py-0.5 text-[11px] uppercase tracking-wide text-muted-foreground">
                  {seg.estimated_pool_size > 0
                    ? `${seg.estimated_pool_size.toLocaleString()} prospects`
                    : "Pool TBD"}
                </span>
              </div>

              {seg.value_angle && (
                <p className="mt-3 rounded-md border border-border/60 bg-background/60 p-3 text-sm">
                  <span className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                    Pitch for this segment
                  </span>
                  <span className="mt-1 block">{seg.value_angle}</span>
                </p>
              )}

              <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
                {(seg.icp.industries ?? []).slice(0, 3).map((ind) => (
                  <span key={ind}>· {ind}</span>
                ))}
                {seg.icp.geography?.[0] && <span>· {seg.icp.geography[0]}</span>}
                {seg.icp.company_size && <span>· {seg.icp.company_size}</span>}
              </div>

              <div className="mt-4 flex flex-wrap items-center gap-2">
                <Button
                  size="sm"
                  variant={isActive ? "default" : "outline"}
                  onClick={() => flip(seg, "active")}
                  disabled={isPending}
                >
                  <CheckCircle2 className="mr-1.5 h-3.5 w-3.5" />
                  {isActive ? "Active" : "Approve"}
                </Button>
                <Button
                  size="sm"
                  variant={isRejected ? "secondary" : "ghost"}
                  onClick={() => flip(seg, "rejected")}
                  disabled={isPending}
                >
                  {isRejected ? "Rejected" : "Not a fit"}
                </Button>
              </div>
            </li>
          );
        })}
      </ul>

      <p className="text-xs text-muted-foreground">
        Skipping is fine — anything you don&apos;t decide on goes through as
        &quot;pending&quot; and we&apos;ll review it together later.
      </p>
    </div>
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
  // Internal agent handles (prospect-01, outreach-01, etc.) are intentionally
  // NOT rendered here — agent assignment is internal Aylek information.
  // The contact sees stage names + descriptions + any conditions only.
  return (
    <ul className="space-y-3 text-sm">
      {stages.map((s, i) => (
        <li key={s.id} className="rounded-lg border border-border/60 bg-background/40 p-3">
          <p className="font-medium">
            {i + 1}. {s.name}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">{s.description}</p>
          {s.condition && (
            <p className="mt-2 rounded-md bg-primary/10 px-2 py-1 text-xs text-primary">
              Rule: {s.condition}
            </p>
          )}
        </li>
      ))}
    </ul>
  );
}
