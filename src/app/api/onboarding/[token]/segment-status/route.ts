import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { createServiceClient } from "@/lib/supabase/server";
import { logEvent } from "@/lib/events";
import type {
  GeneratedPlaybookDraft,
  OnboardingSession,
  PlaybookSegment,
  PlaybookSegmentStatus,
} from "@/lib/supabase/types";

export const dynamic = "force-dynamic";
export const maxDuration = 10;

/**
 * Item 7 — contact flips a single segment's status during the segment
 * review step. We persist the change inside the in-flight onboarding
 * session's generated_playbook so the eventual whole-playbook write
 * (`/api/onboarding/[token]/approve`) carries the right active/rejected
 * subset. Lightweight: no Claude call, no schema regen — just a
 * targeted JSON patch.
 */
const Body = z.object({
  segment_id: z.string().min(1).max(100),
  status: z.enum(["pending_approval", "active", "rejected"]),
});

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
  const { segment_id, status } = parsed.data;

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
      { ok: false, error: "No playbook to update — complete the interview first." },
      { status: 400 },
    );
  }

  const draft: GeneratedPlaybookDraft = session.generated_playbook;
  const segments = (draft.segments ?? []) as PlaybookSegment[];
  const idx = segments.findIndex((s) => s.id === segment_id);
  if (idx < 0) {
    return NextResponse.json({ ok: false, error: "Unknown segment id" }, { status: 404 });
  }

  const nextSegments = segments.map((s, i) =>
    i === idx ? { ...s, status: status as PlaybookSegmentStatus } : s,
  );
  const nextDraft: GeneratedPlaybookDraft = { ...draft, segments: nextSegments };

  await supabase
    .from("onboarding_sessions")
    .update({ generated_playbook: nextDraft })
    .eq("id", session.id);

  await logEvent({
    service: true,
    event_type: "ai_action",
    client_id: session.client_id,
    lead_id: session.lead_id,
    payload: {
      kind: "onboarding_segment_status_changed",
      onboarding_session_id: session.id,
      segment_id,
      status,
    },
  });

  return NextResponse.json({ ok: true, segments: nextSegments });
}
