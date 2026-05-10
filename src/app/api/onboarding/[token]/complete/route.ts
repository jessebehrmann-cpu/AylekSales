import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { createServiceClient } from "@/lib/supabase/server";
import { logEvent } from "@/lib/events";
import { generatePlaybookFromInterview } from "@/lib/onboarding";
import type { OnboardingSession } from "@/lib/supabase/types";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const Body = z.object({
  notes: z.string().max(5000).optional().nullable(),
});

/**
 * Contact clicked "I'm done." Save any final notes, then call Claude to
 * generate the full playbook from the interview transcript.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: { token: string } },
): Promise<NextResponse> {
  const supabase = createServiceClient();
  const json = await req.json().catch(() => ({}));
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

  const answers = {
    ...(session.answers ?? {}),
    notes: parsed.data.notes ?? session.answers?.notes ?? undefined,
    done: true,
  };

  await supabase
    .from("onboarding_sessions")
    .update({
      answers,
      status: "completed",
      completed_at: new Date().toISOString(),
    })
    .eq("id", session.id);

  const { playbook, warning } = await generatePlaybookFromInterview({
    client: { name: session.clients?.name ?? "your company" },
    answers,
  });

  await supabase
    .from("onboarding_sessions")
    .update({
      generated_playbook: playbook,
      status: "playbook_generated",
    })
    .eq("id", session.id);

  await logEvent({
    service: true,
    event_type: "ai_action",
    client_id: session.client_id,
    lead_id: session.lead_id,
    payload: {
      kind: "onboarding_playbook_generated",
      onboarding_session_id: session.id,
      warning: warning ?? null,
    },
  });

  return NextResponse.json({ ok: true, playbook, warning: warning ?? null });
}
