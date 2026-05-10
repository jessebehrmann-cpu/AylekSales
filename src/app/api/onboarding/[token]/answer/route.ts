import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { createServiceClient } from "@/lib/supabase/server";
import { logEvent } from "@/lib/events";
import {
  appendAnswer,
  generateNextQuestion,
  type NextQuestion,
} from "@/lib/onboarding";
import type { OnboardingSession } from "@/lib/supabase/types";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

const Body = z.object({
  topic: z.string().min(1).max(60),
  question: z.string().min(1).max(2000),
  answer: z.string().max(20000),
});

/**
 * Save the contact's latest answer + ask Claude for the next question.
 * Token in the URL is the only auth — service-role client bypasses RLS.
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

  // Append the answer
  const next = appendAnswer(session.answers ?? {}, {
    topic: parsed.data.topic,
    question: parsed.data.question,
    answer: parsed.data.answer.trim(),
    asked_at: new Date().toISOString(),
  });

  await supabase
    .from("onboarding_sessions")
    .update({
      answers: next,
      status: session.status === "pending" ? "in_progress" : session.status,
    })
    .eq("id", session.id);

  // Ask Claude for the next question
  let nextQ: NextQuestion;
  try {
    nextQ = await generateNextQuestion({
      client: { name: session.clients?.name ?? "your company" },
      answers: next,
    });
  } catch (err) {
    return NextResponse.json(
      {
        ok: false,
        error: err instanceof Error ? err.message : "Failed to generate next question",
      },
      { status: 500 },
    );
  }

  await logEvent({
    service: true,
    event_type: "ai_action",
    client_id: session.client_id,
    lead_id: session.lead_id,
    payload: {
      kind: "onboarding_answer_recorded",
      onboarding_session_id: session.id,
      topic: parsed.data.topic,
      next_topic: nextQ.topic,
    },
  });

  return NextResponse.json({
    ok: true,
    next_question: nextQ,
    turn_count: (next.questions ?? []).length,
  });
}
