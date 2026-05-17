"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { requireUser } from "@/lib/auth";
import { logEvent } from "@/lib/events";
import { actionError, type ActionResult } from "@/lib/actions";
import type {
  LeadStage,
  MeetingOutcome,
  Playbook,
  SalesProcessStage,
} from "@/lib/supabase/types";
import { HAVE_MEETING_STAGE_ID } from "@/lib/playbook-defaults";
import {
  markCurrentStageComplete,
  SEND_PROPOSAL_STAGE_ID,
  transitionLeadToStage,
} from "@/lib/stage-engine";
import {
  anthropic,
  ANTHROPIC_KEY_MISSING_MESSAGE,
  ANTHROPIC_MODEL,
  isAnthropicKeyMissing,
  isAnthropicUnavailableError,
} from "@/lib/anthropic";

const STAGES = [
  "new",
  "contacted",
  "replied",
  "meeting_booked",
  "quoted",
  "won",
  "lost",
  "unsubscribed",
] as const;

const optStr = z
  .preprocess((v) => (v === "" || v == null ? undefined : v), z.string().optional());
const optNum = z
  .preprocess((v) => (v === "" || v == null ? undefined : v), z.coerce.number().optional());

const LeadSchema = z.object({
  client_id: z.preprocess((v) => (v === "" || v == null ? undefined : v), z.string().uuid().optional()),
  company_name: z.string().min(1, "Company is required").max(200),
  contact_name: optStr,
  title: optStr,
  email: z.preprocess((v) => (v === "" || v == null ? undefined : v), z.string().email().optional()),
  phone: optStr,
  suburb: optStr,
  industry: optStr,
  employees_estimate: optNum,
  website: optStr,
  contract_value: optNum,
  notes: optStr,
});

function blankToNull<T extends Record<string, unknown>>(o: T): T {
  const out = { ...o };
  for (const k of Object.keys(out)) {
    if (out[k] === "" || out[k] === undefined) (out as Record<string, unknown>)[k] = null;
  }
  return out;
}

export async function createLead(formData: FormData): Promise<ActionResult<{ id: string }>> {
  try {
    const user = await requireUser();
    const parsed = LeadSchema.safeParse(Object.fromEntries(formData));
    if (!parsed.success) {
      return { ok: false, error: parsed.error.issues.map((i) => i.message).join("; ") };
    }
    const data = blankToNull(parsed.data);
    const supabase = createClient();

    const { data: row, error } = await supabase
      .from("leads")
      .insert({ ...data, source: "manual", approval_status: "approved" })
      .select("id, company_name, client_id")
      .single();

    if (error || !row) return { ok: false, error: error?.message ?? "Insert failed" };

    await logEvent({
      event_type: "lead_imported",
      lead_id: row.id,
      client_id: row.client_id,
      user_id: user.auth.id,
      payload: { kind: "manual_create", lead_name: row.company_name },
    });

    revalidatePath("/leads");
    return { ok: true, id: row.id };
  } catch (err) {
    return actionError(err);
  }
}

export async function updateLeadStage(leadId: string, stage: LeadStage): Promise<ActionResult> {
  try {
    if (!STAGES.includes(stage)) return { ok: false, error: "Invalid stage" };
    const user = await requireUser();
    const supabase = createClient();

    const { data: before } = await supabase
      .from("leads")
      .select("stage, company_name, client_id")
      .eq("id", leadId)
      .maybeSingle();

    if (!before) return { ok: false, error: "Lead not found" };

    const { error } = await supabase
      .from("leads")
      .update({
        stage,
        last_contacted_at: stage === "contacted" ? new Date().toISOString() : undefined,
      })
      .eq("id", leadId);

    if (error) return { ok: false, error: error.message };

    await logEvent({
      event_type: "stage_changed",
      lead_id: leadId,
      client_id: before.client_id,
      user_id: user.auth.id,
      payload: { lead_name: before.company_name, before: before.stage, after: stage },
    });

    revalidatePath("/leads");
    revalidatePath(`/leads/${leadId}`);
    revalidatePath("/dashboard");
    return { ok: true };
  } catch (err) {
    return actionError(err);
  }
}

export async function addLeadNote(leadId: string, note: string): Promise<ActionResult> {
  try {
    if (!note.trim()) return { ok: false, error: "Note is empty" };
    const user = await requireUser();
    const supabase = createClient();

    const { data: lead } = await supabase
      .from("leads")
      .select("notes, company_name, client_id")
      .eq("id", leadId)
      .maybeSingle();
    if (!lead) return { ok: false, error: "Lead not found" };

    const stamp = new Date().toISOString();
    const appended = lead.notes
      ? `${lead.notes}\n\n— ${stamp}\n${note.trim()}`
      : `— ${stamp}\n${note.trim()}`;

    const { error } = await supabase.from("leads").update({ notes: appended }).eq("id", leadId);
    if (error) return { ok: false, error: error.message };

    await logEvent({
      event_type: "note_added",
      lead_id: leadId,
      client_id: lead.client_id,
      user_id: user.auth.id,
      payload: { lead_name: lead.company_name, note: note.trim().slice(0, 200) },
    });

    revalidatePath(`/leads/${leadId}`);
    return { ok: true };
  } catch (err) {
    return actionError(err);
  }
}

export async function deleteLead(leadId: string): Promise<ActionResult> {
  try {
    const user = await requireUser();
    const supabase = createClient();

    const { data: lead } = await supabase
      .from("leads")
      .select("company_name, client_id")
      .eq("id", leadId)
      .maybeSingle();

    const { error } = await supabase.from("leads").delete().eq("id", leadId);
    if (error) return { ok: false, error: error.message };

    await logEvent({
      event_type: "ai_action",
      client_id: lead?.client_id ?? null,
      user_id: user.auth.id,
      payload: { kind: "lead_deleted", lead_name: lead?.company_name },
    });

    revalidatePath("/leads");
    return { ok: true };
  } catch (err) {
    return actionError(err);
  }
}

export async function deleteLeadAndRedirect(leadId: string): Promise<void> {
  await deleteLead(leadId);
  redirect("/leads");
}

/**
 * HOS marks the current human-owned process stage complete. Delegates to
 * the stage engine, which:
 *   • resolves the open `human_stage_task` for the current stage,
 *   • advances the lead to the next stage,
 *   • runs every destination-side effect (e.g. auto-create proposal_review
 *     if the next stage is Send Proposal).
 *
 * Refuses to act if the lead isn't on a human-owned stage. Refuses on
 * Have-Meeting unless `allowHaveMeeting` is set — that path goes through
 * submitMeetingNotes() so we capture meeting context.
 */
export async function markHumanStageComplete(
  leadId: string,
  opts: { allowHaveMeeting?: boolean } = {},
): Promise<ActionResult<{ next_stage_id: string | null; next_is_human: boolean }>> {
  try {
    const user = await requireUser();
    const supabase = createClient();

    if (!opts.allowHaveMeeting) {
      const { data: lead } = await supabase
        .from("leads")
        .select("process_stage_id")
        .eq("id", leadId)
        .maybeSingle();
      if (lead?.process_stage_id === HAVE_MEETING_STAGE_ID) {
        return {
          ok: false,
          error: "Have Meeting completion requires meeting notes — open the post-meeting form.",
        };
      }
    }

    const r = await markCurrentStageComplete(supabase, leadId, {
      userId: user.auth.id,
    });
    if (!r.ok) return r;

    revalidatePath(`/leads/${leadId}`);
    revalidatePath("/leads");
    revalidatePath("/approvals");
    revalidatePath("/dashboard");
    return {
      ok: true,
      next_stage_id: r.to_stage_id,
      next_is_human: r.transition?.to_stage_agent === "human",
    };
  } catch (err) {
    return actionError(err);
  }
}

const MeetingNotesSchema = z.object({
  lead_id: z.string().uuid(),
  outcome: z.enum(["positive", "neutral", "negative", "no_show"]),
  notes: z.string().max(8000).optional().nullable(),
  transcript: z.string().max(50000).optional().nullable(),
  objections: z.string().max(4000).optional().nullable(),
  next_steps: z.string().max(4000).optional().nullable(),
});

/**
 * Capture the post-meeting form for the Have-Meeting stage. Saves the meeting
 * notes, drafts a follow-up proposal email via Claude (anchored on the
 * playbook strategy + voice + the meeting context), then hands off to the
 * stage engine to:
 *   • resolve the Have-Meeting human_stage_task,
 *   • advance the lead to the next stage,
 *   • create the proposal_review approval (the engine auto-creates one
 *     when entering Send Proposal — we pass our richer drafted context
 *     through so the engine writes that instead of the placeholder).
 *
 * Replaces the bare Mark Complete on this one stage. Other human stages
 * keep using markHumanStageComplete().
 */
export async function submitMeetingNotes(
  input: unknown,
): Promise<ActionResult<{ meeting_note_id: string; approval_id: string | null; advanced_to: string | null }>> {
  try {
    const user = await requireUser();
    const parsed = MeetingNotesSchema.safeParse(input);
    if (!parsed.success) {
      return { ok: false, error: parsed.error.issues.map((i) => i.message).join("; ") };
    }
    const data = parsed.data;
    const supabase = createClient();

    // Verify the lead is on Have Meeting
    const { data: lead } = await supabase
      .from("leads")
      .select("id, client_id, process_stage_id, company_name, contact_name, email, title, industry")
      .eq("id", data.lead_id)
      .maybeSingle();
    if (!lead) return { ok: false, error: "Lead not found" };
    if (!lead.client_id) return { ok: false, error: "Lead has no client" };

    const { data: pb } = await supabase
      .from("playbooks")
      .select("*")
      .eq("client_id", lead.client_id)
      .eq("status", "approved")
      .maybeSingle();
    const playbook = pb as Playbook | null;
    const stages = (playbook?.sales_process ?? []) as SalesProcessStage[];
    const currentIdx = lead.process_stage_id
      ? stages.findIndex((s) => s.id === lead.process_stage_id)
      : -1;
    const currentStage = currentIdx >= 0 ? stages[currentIdx] : null;
    if (!currentStage || currentStage.id !== HAVE_MEETING_STAGE_ID) {
      return {
        ok: false,
        error: "Meeting notes can only be submitted on the Have Meeting stage.",
      };
    }
    const nextStage = stages[currentIdx + 1] ?? null;

    // 1. Save meeting note. We patch related_approval_id in step 4 once the
    //    engine has created the proposal_review.
    const { data: noteRow, error: noteErr } = await supabase
      .from("meeting_notes")
      .insert({
        lead_id: data.lead_id,
        client_id: lead.client_id,
        outcome: data.outcome,
        notes: data.notes ?? null,
        transcript: data.transcript ?? null,
        objections: data.objections ?? null,
        next_steps: data.next_steps ?? null,
        created_by: user.auth.id,
      })
      .select("id")
      .single();
    if (noteErr || !noteRow) {
      return { ok: false, error: noteErr?.message ?? "Failed to save meeting notes" };
    }

    // 2. Draft a follow-up proposal via Claude (graceful when no key). For
    //    no_show outcomes we skip the draft and let the engine put the
    //    placeholder in (no proposal yet — wait for the next interaction).
    const draft = data.outcome === "no_show"
      ? null
      : await draftFollowUpProposal({
          playbook,
          lead: {
            company_name: lead.company_name,
            contact_name: lead.contact_name,
            title: lead.title,
            industry: lead.industry,
          },
          outcome: data.outcome,
          notes: data.notes ?? "",
          transcript: data.transcript ?? "",
          objections: data.objections ?? "",
          next_steps: data.next_steps ?? "",
        });

    // 3. Resolve the open human_stage_task and advance via the engine.
    //    Pass the drafted proposal context through so the engine writes it
    //    into the proposal_review approval (instead of the placeholder).
    const stageResult = await markCurrentStageComplete(supabase, lead.id, {
      userId: user.auth.id,
      allowedStageId: currentStage.id,
    });
    if (!stageResult.ok) return stageResult;

    let approvalId: string | null = null;
    if (
      stageResult.transition?.to_stage_id === SEND_PROPOSAL_STAGE_ID &&
      draft
    ) {
      // The engine created a placeholder proposal_review (no draft was
      // available at engine time). Patch it with the rich draft we made.
      const placeholderId = stageResult.transition.proposal_review_approval_id;
      if (placeholderId) {
        await supabase
          .from("approvals")
          .update({
            title: `${lead.company_name}: review proposal draft`,
            summary: `Post-meeting follow-up (${data.outcome}). Claude drafted a proposal — review + send.`,
            payload: {
              lead_id: lead.id,
              meeting_note_id: noteRow.id,
              drafted_subject: draft.subject,
              drafted_body: draft.body,
              outcome: data.outcome,
              source: "post_meeting",
              ai_warning: draft.warning ?? null,
            },
          })
          .eq("id", placeholderId);
        approvalId = placeholderId;

        await supabase
          .from("meeting_notes")
          .update({
            related_approval_id: approvalId,
            drafted_proposal_subject: draft.subject,
            drafted_proposal_body: draft.body,
          })
          .eq("id", noteRow.id);
      }
    }

    await logEvent({
      event_type: "meeting_completed",
      lead_id: lead.id,
      client_id: lead.client_id,
      user_id: user.auth.id,
      payload: {
        kind: "meeting_notes_captured",
        lead_name: lead.company_name,
        outcome: data.outcome,
        meeting_note_id: noteRow.id,
        proposal_approval_id: approvalId,
        next_stage_id: nextStage?.id ?? null,
      },
    });

    revalidatePath(`/leads/${lead.id}`);
    revalidatePath("/leads");
    revalidatePath("/approvals");
    revalidatePath("/dashboard");
    return {
      ok: true,
      meeting_note_id: noteRow.id,
      approval_id: approvalId,
      advanced_to: nextStage?.id ?? null,
    };
  } catch (err) {
    return actionError(err);
  }
}

async function draftFollowUpProposal(input: {
  playbook: Playbook | null;
  lead: { company_name: string; contact_name: string | null; title: string | null; industry: string | null };
  outcome: MeetingOutcome;
  notes: string;
  transcript: string;
  objections: string;
  next_steps: string;
}): Promise<{ subject: string; body: string; warning?: string }> {
  const fallbackSubject = `Following up on our chat — ${input.lead.company_name}`;
  const fallbackBody = `Hi ${input.lead.contact_name?.split(" ")[0] ?? "there"},\n\nThanks for the time today. Quick recap of where we landed:\n\n${input.next_steps || input.notes || "<add the agreed next steps>"}\n\n<insert your proposal here once you've reviewed the meeting notes>\n\nAylek Sales`;

  if (isAnthropicKeyMissing()) {
    return { subject: fallbackSubject, body: fallbackBody, warning: ANTHROPIC_KEY_MISSING_MESSAGE };
  }

  const strategy = input.playbook?.strategy ?? {};
  const voice = input.playbook?.voice_tone ?? {};
  const system =
    "You write follow-up proposal emails after a sales discovery call. Stick to the supplied Voice & Tone and Strategy. Max 6 sentences in the body. One clear next-step CTA. Reference 1-2 specific points from the meeting. No price talk unless next_steps explicitly asks for one.";
  const prompt = `You are drafting a follow-up email for ${input.lead.company_name} after a discovery call.

Lead: ${input.lead.contact_name ?? ""} (${input.lead.title ?? ""}) at ${input.lead.company_name} — ${input.lead.industry ?? ""}

Meeting outcome: ${input.outcome}

Meeting notes:
${input.notes || "(none)"}

Transcript snippets:
${input.transcript ? input.transcript.slice(0, 4000) : "(none)"}

Key objections raised:
${input.objections || "(none)"}

Agreed next steps:
${input.next_steps || "(none)"}

STRATEGY
${JSON.stringify(strategy, null, 2)}

VOICE & TONE
${JSON.stringify(voice, null, 2)}

Return ONLY valid JSON, no markdown:
{"subject":"...","body":"..."}

The subject is under 70 characters. The body opens with the contact's first name (no "Hi" if voice prefers lowercase) and references at least one specific thing from the meeting.`;

  try {
    const response = await anthropic.messages.create({
      model: ANTHROPIC_MODEL,
      max_tokens: 1500,
      system,
      messages: [{ role: "user", content: prompt }],
    });
    const text = response.content[0]?.type === "text" ? response.content[0].text : "";
    // Strip code fence if present
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    const raw = (fenced ? fenced[1] : text).trim();
    const parsed = JSON.parse(raw) as { subject?: string; body?: string };
    if (!parsed.subject || !parsed.body) {
      return { subject: fallbackSubject, body: fallbackBody, warning: "AI returned an invalid shape — placeholder used." };
    }
    return { subject: parsed.subject.slice(0, 200), body: parsed.body };
  } catch (err) {
    if (isAnthropicUnavailableError(err)) {
      return { subject: fallbackSubject, body: fallbackBody, warning: ANTHROPIC_KEY_MISSING_MESSAGE };
    }
    return {
      subject: fallbackSubject,
      body: fallbackBody,
      warning: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Halt all outreach for a lead. Flips stage='unsubscribed', cancels every
 * pending email scheduled for them, logs the change. Used by the
 * Unsubscribe button on the lead detail page.
 */
export async function unsubscribeLead(leadId: string): Promise<ActionResult> {
  try {
    const user = await requireUser();
    const supabase = createClient();

    const { data: lead } = await supabase
      .from("leads")
      .select("company_name, client_id, stage")
      .eq("id", leadId)
      .maybeSingle();
    if (!lead) return { ok: false, error: "Lead not found" };

    const { error: leadErr } = await supabase
      .from("leads")
      .update({ stage: "unsubscribed" })
      .eq("id", leadId);
    if (leadErr) return { ok: false, error: leadErr.message };

    // Cancel every pending email for this lead
    const { error: emailErr } = await supabase
      .from("emails")
      .update({ status: "failed" })
      .eq("lead_id", leadId)
      .eq("status", "pending");
    if (emailErr) {
      console.error("[unsubscribe] cancel pending emails failed", emailErr);
    }

    await logEvent({
      event_type: "stage_changed",
      lead_id: leadId,
      client_id: lead.client_id,
      user_id: user.auth.id,
      payload: {
        kind: "unsubscribed_via_button",
        lead_name: lead.company_name,
        before: lead.stage,
        after: "unsubscribed",
      },
    });

    revalidatePath(`/leads/${leadId}`);
    revalidatePath("/leads");
    revalidatePath("/dashboard");
    return { ok: true };
  } catch (err) {
    return actionError(err);
  }
}

/**
 * Manually move a lead to a sales-process stage (clicking a node on the
 * timeline). Delegates to the stage engine, which handles every
 * destination-side effect (human task, proposal review, paused outreach).
 */
export async function moveLeadToProcessStage(
  leadId: string,
  stageId: string,
): Promise<ActionResult> {
  try {
    const user = await requireUser();
    const supabase = createClient();

    const r = await transitionLeadToStage(supabase, leadId, stageId, {
      userId: user.auth.id,
    });
    if (!r.ok) return r;

    revalidatePath(`/leads/${leadId}`);
    revalidatePath("/leads");
    revalidatePath("/approvals");
    revalidatePath("/dashboard");
    return { ok: true };
  } catch (err) {
    return actionError(err);
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Bulk approve / reject (Item 6)
//
// HOS selects N pending-approval leads on the /leads list and decides them
// all in one round-trip. After the bulk update we run a single pass over
// every parent `lead_list` approval those leads belong to, auto-finalising
// any that now have zero undecided leads (same rule as the per-lead
// inline approve in approvals/actions.ts → decideLeadInBatch).
// ──────────────────────────────────────────────────────────────────────────

const BulkLeadDecisionSchema = z.object({
  lead_ids: z.array(z.string().uuid()).min(1).max(500),
});

export async function bulkApproveLeads(
  input: unknown,
): Promise<ActionResult<{ updated: number; finalised_approval_ids: string[] }>> {
  return bulkDecideLeads(input, "approved");
}

export async function bulkRejectLeads(
  input: unknown,
): Promise<ActionResult<{ updated: number; finalised_approval_ids: string[] }>> {
  return bulkDecideLeads(input, "rejected");
}

async function bulkDecideLeads(
  input: unknown,
  decision: "approved" | "rejected",
): Promise<ActionResult<{ updated: number; finalised_approval_ids: string[] }>> {
  try {
    const user = await requireUser();
    const parsed = BulkLeadDecisionSchema.safeParse(input);
    if (!parsed.success) {
      return { ok: false, error: parsed.error.issues.map((i) => i.message).join("; ") };
    }
    const ids = parsed.data.lead_ids;
    const supabase = createClient();

    // 1. Flip every lead in the set.
    const { error: updErr, count } = await supabase
      .from("leads")
      .update({ approval_status: decision }, { count: "exact" })
      .in("id", ids)
      .eq("approval_status", "pending_approval"); // only those still pending
    if (updErr) return { ok: false, error: updErr.message };

    // 2. Log one bulk event per client_id the leads touched (so per-client
    //    activity feeds stay readable). Cheap: one extra round-trip.
    const { data: touchedRows } = await supabase
      .from("leads")
      .select("client_id")
      .in("id", ids);
    const clientIds = new Set(
      ((touchedRows ?? []) as Array<{ client_id: string | null }>)
        .map((r) => r.client_id)
        .filter((id): id is string => !!id),
    );
    await Promise.all(
      Array.from(clientIds).map((clientId) =>
        logEvent({
          event_type: "ai_action",
          client_id: clientId,
          user_id: user.auth.id,
          payload: {
            kind: decision === "approved" ? "lead_list_approved" : "approval_rejected",
            via: "bulk_action",
            decided_count: ids.length,
          },
        }),
      ),
    );

    // 3. Find every parent lead_list approval those leads belong to + check
    //    whether it's now fully decided. If so, auto-finalise (enrol the
    //    approved subset into the linked campaign) and mark the parent
    //    approved.
    const { data: parentApprovals } = await supabase
      .from("approvals")
      .select("id, type, status, payload, client_id, related_campaign_id, created_at")
      .eq("type", "lead_list")
      .eq("status", "pending");
    const candidates = (parentApprovals ?? []) as Array<{
      id: string;
      type: string;
      status: string;
      payload: { lead_ids?: string[] } | null;
      client_id: string;
      related_campaign_id: string | null;
      created_at: string;
    }>;

    const finalisedIds: string[] = [];
    for (const appr of candidates) {
      const batchIds = appr.payload?.lead_ids ?? [];
      if (batchIds.length === 0) continue;
      // Is at least one of our decided leads in this batch?
      const overlap = batchIds.some((id) => ids.includes(id));
      if (!overlap) continue;
      // Are all leads in the batch now decided (none still pending)?
      const { count: stillPendingCount } = await supabase
        .from("leads")
        .select("id", { count: "exact", head: true })
        .in("id", batchIds)
        .eq("approval_status", "pending_approval");
      if ((stillPendingCount ?? 0) > 0) continue;

      // Mark parent approved + (best-effort) enrol the approved subset via
      // the approvals action's existing logic. We avoid importing it
      // directly (circular) — duplicate the minimal finalise + leave the
      // full enrol flow to the existing single-lead path. The HOS can
      // re-open the approval card if anything looks off.
      await supabase
        .from("approvals")
        .update({
          status: "approved",
          approved_by: user.auth.id,
          decided_at: new Date().toISOString(),
        })
        .eq("id", appr.id);

      await logEvent({
        event_type: "ai_action",
        client_id: appr.client_id,
        user_id: user.auth.id,
        payload: {
          kind: "lead_list_auto_finalised",
          approval_id: appr.id,
          via: "bulk_action",
        },
      });

      finalisedIds.push(appr.id);
    }

    revalidatePath("/leads");
    revalidatePath("/approvals");
    revalidatePath("/dashboard");
    return { ok: true, updated: count ?? ids.length, finalised_approval_ids: finalisedIds };
  } catch (err) {
    return actionError(err);
  }
}
