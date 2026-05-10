import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { createServiceClient } from "@/lib/supabase/server";
import { logEvent } from "@/lib/events";
import type { OnboardingSession } from "@/lib/supabase/types";

export const dynamic = "force-dynamic";
export const maxDuration = 15;

const Body = z.object({
  contact_name: z.string().trim().min(1).max(120),
  company_name: z.string().trim().min(1).max(200),
});

/**
 * Capture the contact's first name + their company name at the very start
 * of the onboarding interview. Stored on `answers.contact_name` and
 * `answers.company_name` so every subsequent Claude prompt + UI greeting
 * can use the contact-supplied values (and never the internal
 * `clients.name`).
 */
export async function POST(
  req: NextRequest,
  { params }: { params: { token: string } },
): Promise<NextResponse> {
  const supabase = createServiceClient();
  const json = await req.json().catch(() => null);
  const parsed = Body.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json({ ok: false, error: "Name and company are required." }, { status: 400 });
  }

  const { data: row } = await supabase
    .from("onboarding_sessions")
    .select("id, status, answers, client_id, lead_id")
    .eq("token", params.token)
    .maybeSingle();
  const session = row as OnboardingSession | null;
  if (!session) {
    return NextResponse.json({ ok: false, error: "Session not found" }, { status: 404 });
  }
  if (session.status === "approved") {
    return NextResponse.json({ ok: false, error: "Session already approved" }, { status: 409 });
  }

  // Take only the first word as the first name (in case they entered a full name).
  const firstName = parsed.data.contact_name.split(/\s+/)[0] ?? parsed.data.contact_name;
  const nextAnswers = {
    ...(session.answers ?? {}),
    contact_name: firstName,
    company_name: parsed.data.company_name,
  };

  const { error } = await supabase
    .from("onboarding_sessions")
    .update({
      answers: nextAnswers,
      status: session.status === "pending" ? "in_progress" : session.status,
    })
    .eq("id", session.id);

  if (error) {
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }

  await logEvent({
    service: true,
    event_type: "ai_action",
    client_id: session.client_id,
    lead_id: session.lead_id,
    payload: {
      kind: "onboarding_intro_captured",
      onboarding_session_id: session.id,
      contact_name: firstName,
      company_name: parsed.data.company_name,
    },
  });

  return NextResponse.json({
    ok: true,
    contact_name: firstName,
    company_name: parsed.data.company_name,
  });
}
