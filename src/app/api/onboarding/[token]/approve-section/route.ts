import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { createServiceClient } from "@/lib/supabase/server";
import { logEvent } from "@/lib/events";
import { isOnboardingSection } from "@/lib/onboarding";
import type { OnboardingSession } from "@/lib/supabase/types";

export const dynamic = "force-dynamic";
export const maxDuration = 15;

const Body = z.object({
  section: z.string(),
});

/**
 * Mark one playbook section as client-approved. The section approvals
 * accumulate in `answers.section_approvals`. The whole-playbook write
 * (`/api/onboarding/[token]/approve`) is gated on every section being
 * approved, so this endpoint is the per-section step in the
 * section-by-section review flow.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: { token: string } },
): Promise<NextResponse> {
  const supabase = createServiceClient();
  const json = await req.json().catch(() => null);
  const parsed = Body.safeParse(json);
  if (!parsed.success || !isOnboardingSection(parsed.data.section)) {
    return NextResponse.json({ ok: false, error: "Invalid section" }, { status: 400 });
  }
  const section = parsed.data.section;

  const { data: row } = await supabase
    .from("onboarding_sessions")
    .select("*")
    .eq("token", params.token)
    .maybeSingle();
  const session = row as OnboardingSession | null;
  if (!session) {
    return NextResponse.json({ ok: false, error: "Session not found" }, { status: 404 });
  }
  if (session.status === "approved") {
    return NextResponse.json({ ok: false, error: "Session already approved" }, { status: 409 });
  }
  if (!session.generated_playbook) {
    return NextResponse.json(
      { ok: false, error: "No playbook to approve — complete the interview first." },
      { status: 400 },
    );
  }

  const nextApprovals = {
    ...(session.answers?.section_approvals ?? {}),
    [section]: true,
  };
  const nextAnswers = {
    ...(session.answers ?? {}),
    section_approvals: nextApprovals,
  };

  await supabase
    .from("onboarding_sessions")
    .update({ answers: nextAnswers })
    .eq("id", session.id);

  await logEvent({
    service: true,
    event_type: "ai_action",
    client_id: session.client_id,
    lead_id: session.lead_id,
    payload: {
      kind: "onboarding_section_approved",
      onboarding_session_id: session.id,
      section,
    },
  });

  return NextResponse.json({ ok: true, section_approvals: nextApprovals });
}
