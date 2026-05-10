import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { requireUser } from "@/lib/auth";
import { resendOnboardingEmail } from "@/lib/onboarding-trigger";
import type { OnboardingSession } from "@/lib/supabase/types";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * HOS-only: resend the onboarding interview email for an existing session.
 * Looks up the session by token (URL param). Auth required — bounces anon.
 */
export async function POST(
  _req: NextRequest,
  { params }: { params: { token: string } },
): Promise<NextResponse> {
  await requireUser();
  const supabase = createClient();
  const { data: row } = await supabase
    .from("onboarding_sessions")
    .select("id")
    .eq("token", params.token)
    .maybeSingle();
  const session = row as Pick<OnboardingSession, "id"> | null;
  if (!session) {
    return NextResponse.json({ ok: false, error: "Session not found" }, { status: 404 });
  }
  const r = await resendOnboardingEmail(supabase, session.id);
  if (!r.ok) return NextResponse.json(r, { status: 500 });
  return NextResponse.json({ ok: true, email_sent: r.email_sent, warning: r.warning ?? null });
}
