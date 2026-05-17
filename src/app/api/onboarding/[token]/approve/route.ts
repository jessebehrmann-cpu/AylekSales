import { NextResponse, type NextRequest } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { logEvent } from "@/lib/events";
import type {
  GeneratedPlaybookDraft,
  OnboardingSectionId,
  OnboardingSession,
  PlaybookApprovalPayload,
} from "@/lib/supabase/types";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * Contact has approved their generated playbook. Persist the playbook to
 * public.playbooks with status='pending_approval' (so the DB hard gate on
 * campaigns still requires HOS sign-off), flip the session to 'approved',
 * and open a `playbook_approval` for the HOS to do the final review.
 *
 * Idempotent: if there's already a pending playbook for this client tied
 * to this onboarding session, we reuse it.
 */
export async function POST(
  _req: NextRequest,
  { params }: { params: { token: string } },
): Promise<NextResponse> {
  const supabase = createServiceClient();

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
    return NextResponse.json({ ok: true, already_approved: true });
  }
  if (!session.generated_playbook) {
    return NextResponse.json(
      { ok: false, error: "No playbook to approve — complete the interview first." },
      { status: 400 },
    );
  }

  // Gate: every section must be marked approved by the contact via the
  // section-by-section review flow before the playbook gets written and
  // the HOS approval is created. NOTE: Item 7 added a "segments" section
  // that is intentionally NOT in this list — per the master brief
  // refinement, whole-playbook approval is not gated on segment decisions
  // (that gate activates after client 3). Contacts can flip individual
  // segment statuses; rejected segments are filtered out of the written
  // playbook below, but the playbook itself ships either way.
  const REQUIRED_SECTIONS: OnboardingSectionId[] = [
    "icp",
    "strategy",
    "voice_tone",
    "sequences",
    "sales_process",
  ];
  const sectionApprovals = session.answers?.section_approvals ?? {};
  const missing = REQUIRED_SECTIONS.filter((s) => sectionApprovals[s] !== true);
  if (missing.length > 0) {
    return NextResponse.json(
      {
        ok: false,
        error: "All sections must be approved before the playbook can be submitted.",
        missing_sections: missing,
      },
      { status: 400 },
    );
  }

  const draft: GeneratedPlaybookDraft = session.generated_playbook;
  const clientName = session.clients?.name ?? "Client";

  // Look up the latest existing playbook for the client to determine the
  // next version number.
  const { data: existingRows } = await supabase
    .from("playbooks")
    .select("id, version")
    .eq("client_id", session.client_id)
    .order("version", { ascending: false })
    .limit(1);
  const nextVersion =
    existingRows && existingRows.length > 0 ? (existingRows[0].version ?? 0) + 1 : 1;

  // Insert the playbook. Status='pending_approval' so the HOS approval
  // queue carries the final flip → 'approved'.
  const { data: insertedPb, error: pbErr } = await supabase
    .from("playbooks")
    .insert({
      client_id: session.client_id,
      version: nextVersion,
      status: "pending_approval",
      icp: draft.icp,
      sequences: draft.sequences,
      escalation_rules: draft.escalation_rules ?? [{ after_step: 3, action: "pause" }],
      channel_flags: draft.channel_flags ?? { email: true, phone: false, linkedin: false },
      strategy: draft.strategy,
      voice_tone: draft.voice_tone,
      reply_strategy: draft.reply_strategy,
      team_members: draft.team_members,
      sales_process: draft.sales_process,
      // Item 7 — carry segments through, dropping any the contact explicitly
      // rejected during section review. Contacts who never flipped a status
      // leave segments at "pending_approval"; those still write through and
      // HOS can flip them from the playbook editor later.
      segments: (draft.segments ?? []).filter((s) => s.status !== "rejected"),
      notes: draft.notes ?? null,
      submitted_at: new Date().toISOString(),
    })
    .select("id")
    .single();
  if (pbErr || !insertedPb) {
    return NextResponse.json(
      { ok: false, error: pbErr?.message ?? "Failed to insert playbook" },
      { status: 500 },
    );
  }
  const playbookId = (insertedPb as { id: string }).id;

  // Create the HOS-final-review approval.
  const apprPayload: PlaybookApprovalPayload = {
    onboarding_session_id: session.id,
    client_id: session.client_id,
    client_name: clientName,
    feedback_round_count: (session.feedback_rounds ?? []).length,
  };

  await supabase.from("approvals").insert({
    client_id: session.client_id,
    type: "playbook_approval",
    status: "pending",
    title: `${clientName}: client-approved playbook ready for final review`,
    summary: `${clientName} has finished the onboarding interview, reviewed the generated playbook, and approved it. Final HOS sign-off needed before agents go live.`,
    payload: apprPayload as unknown as Record<string, unknown>,
    related_playbook_id: playbookId,
  });

  // Flip the session
  await supabase
    .from("onboarding_sessions")
    .update({ status: "approved", approved_at: new Date().toISOString() })
    .eq("id", session.id);

  await logEvent({
    service: true,
    event_type: "ai_action",
    client_id: session.client_id,
    lead_id: session.lead_id,
    payload: {
      kind: "onboarding_client_approved",
      onboarding_session_id: session.id,
      playbook_id: playbookId,
      client_name: clientName,
      feedback_rounds: (session.feedback_rounds ?? []).length,
    },
  });

  return NextResponse.json({ ok: true, playbook_id: playbookId });
}
