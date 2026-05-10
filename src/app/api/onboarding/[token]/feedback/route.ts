import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { createServiceClient } from "@/lib/supabase/server";
import { logEvent } from "@/lib/events";
import {
  appendFeedbackRound,
  appendSectionFeedbackRound,
  generatePlaybookFromInterview,
  isOnboardingSection,
  regeneratePlaybookSection,
  setSection,
} from "@/lib/onboarding";
import type { OnboardingSession } from "@/lib/supabase/types";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const Body = z.object({
  feedback: z.string().min(2).max(8000),
  /** Optional — when present, regenerate ONLY that section. Otherwise the
   *  whole playbook is regenerated (legacy / back-compat path). */
  section: z.string().optional(),
});

/**
 * Contact requested changes to the generated playbook.
 *  • If `section` is provided, regenerate ONLY that section and replace
 *    it in `generated_playbook[section]`.
 *  • Otherwise, regenerate the whole playbook (back-compat).
 *
 * Either way: append a new entry to `feedback_rounds` so HOS sees the
 * full revision history.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: { token: string } },
): Promise<NextResponse> {
  const supabase = createServiceClient();
  const json = await req.json().catch(() => null);
  const parsed = Body.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json({ ok: false, error: "Invalid body" }, { status: 400 });
  }

  const { data: row } = await supabase
    .from("onboarding_sessions")
    .select("*, clients(name)")
    .eq("token", params.token)
    .maybeSingle();
  const session = row as
    | (OnboardingSession & { clients: { name: string } | null })
    | null;
  if (!session) {
    return NextResponse.json({ ok: false, error: "Session not found" }, { status: 404 });
  }
  if (session.status === "approved") {
    return NextResponse.json({ ok: false, error: "Session already approved" }, { status: 409 });
  }
  if (!session.generated_playbook) {
    return NextResponse.json(
      { ok: false, error: "No prior playbook to revise — complete the interview first." },
      { status: 400 },
    );
  }

  const priorPlaybook = session.generated_playbook;
  const clientName = session.clients?.name ?? "your company";

  // ── Section-targeted feedback ────────────────────────────────────────
  if (parsed.data.section) {
    if (!isOnboardingSection(parsed.data.section)) {
      return NextResponse.json(
        { ok: false, error: `Unknown section: ${parsed.data.section}` },
        { status: 400 },
      );
    }
    const section = parsed.data.section;
    const result = await regeneratePlaybookSection({
      client: { name: clientName },
      answers: session.answers ?? {},
      currentPlaybook: priorPlaybook,
      section,
      feedback: parsed.data.feedback,
    });

    const nextPlaybook = setSection(priorPlaybook, section, result.content);
    const nextRounds = appendSectionFeedbackRound(
      session.feedback_rounds ?? [],
      parsed.data.feedback,
      section,
      priorPlaybook[section],
    );

    // Reset the section's approval flag — they'll need to approve the new
    // version explicitly.
    const nextAnswers = {
      ...(session.answers ?? {}),
      section_approvals: {
        ...(session.answers?.section_approvals ?? {}),
        [section]: false,
      },
    };

    await supabase
      .from("onboarding_sessions")
      .update({
        generated_playbook: nextPlaybook,
        feedback_rounds: nextRounds,
        answers: nextAnswers,
      })
      .eq("id", session.id);

    await logEvent({
      service: true,
      event_type: "ai_action",
      client_id: session.client_id,
      lead_id: session.lead_id,
      payload: {
        kind: "onboarding_section_feedback",
        onboarding_session_id: session.id,
        section,
        round: nextRounds.length,
        warning: result.warning ?? null,
      },
    });

    return NextResponse.json({
      ok: true,
      section,
      content: result.content,
      warning: result.warning ?? null,
      round: nextRounds.length,
    });
  }

  // ── Whole-playbook feedback (legacy) ─────────────────────────────────
  const nextRounds = appendFeedbackRound(
    session.feedback_rounds ?? [],
    parsed.data.feedback,
    priorPlaybook,
  );
  const { playbook, warning } = await generatePlaybookFromInterview({
    client: { name: clientName },
    answers: session.answers ?? {},
    feedback: { feedback: parsed.data.feedback, prior_playbook: priorPlaybook },
  });

  // Reset all section approvals on a whole-playbook regen.
  const nextAnswers = {
    ...(session.answers ?? {}),
    section_approvals: {},
  };

  await supabase
    .from("onboarding_sessions")
    .update({
      generated_playbook: playbook,
      feedback_rounds: nextRounds,
      answers: nextAnswers,
    })
    .eq("id", session.id);

  await logEvent({
    service: true,
    event_type: "ai_action",
    client_id: session.client_id,
    lead_id: session.lead_id,
    payload: {
      kind: "onboarding_feedback_round",
      onboarding_session_id: session.id,
      round: nextRounds.length,
      warning: warning ?? null,
    },
  });

  return NextResponse.json({
    ok: true,
    playbook,
    warning: warning ?? null,
    round: nextRounds.length,
  });
}
