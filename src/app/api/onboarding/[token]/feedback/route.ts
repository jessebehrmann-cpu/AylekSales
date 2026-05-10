import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { createServiceClient } from "@/lib/supabase/server";
import { logEvent } from "@/lib/events";
import {
  appendFeedbackRound,
  generatePlaybookFromInterview,
} from "@/lib/onboarding";
import type { OnboardingSession } from "@/lib/supabase/types";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const Body = z.object({
  feedback: z.string().min(2).max(8000),
});

/**
 * Contact requested changes to the generated playbook. Append this round to
 * feedback_rounds, then call Claude to regenerate using the prior draft +
 * the contact's feedback as context.
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
  const nextRounds = appendFeedbackRound(
    session.feedback_rounds ?? [],
    parsed.data.feedback,
    priorPlaybook,
  );

  const { playbook, warning } = await generatePlaybookFromInterview({
    client: { name: session.clients?.name ?? "your company" },
    answers: session.answers ?? {},
    feedback: { feedback: parsed.data.feedback, prior_playbook: priorPlaybook },
  });

  await supabase
    .from("onboarding_sessions")
    .update({
      generated_playbook: playbook,
      feedback_rounds: nextRounds,
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
