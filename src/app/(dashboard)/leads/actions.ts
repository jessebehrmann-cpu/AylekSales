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
  ProposalReviewPayload,
  SalesProcessStage,
} from "@/lib/supabase/types";
import { HAVE_MEETING_STAGE_ID, isHumanStage } from "@/lib/playbook-defaults";
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
 * HOS marks the current human-owned process stage complete. The lead
 * advances to the next stage in the playbook's sales_process. If the next
 * stage is also human, automation stays paused (HOS will mark that one too).
 * If the next stage is owned by an agent, automation may resume on the next
 * cron tick.
 *
 * Refuses to act if the lead's current stage isn't owned by a human (so
 * accidental clicks on a non-human stage are no-ops). Refuses on the
 * Have-Meeting stage too — that goes through submitMeetingNotes() instead.
 */
export async function markHumanStageComplete(
  leadId: string,
  opts: { allowHaveMeeting?: boolean } = {},
): Promise<ActionResult<{ next_stage_id: string | null; next_is_human: boolean }>> {
  try {
    const user = await requireUser();
    const supabase = createClient();

    const { data: lead } = await supabase
      .from("leads")
      .select("client_id, process_stage_id, stage, company_name")
      .eq("id", leadId)
      .maybeSingle();
    if (!lead) return { ok: false, error: "Lead not found" };
    if (!lead.client_id) return { ok: false, error: "Lead has no client" };

    const { data: pb } = await supabase
      .from("playbooks")
      .select("sales_process")
      .eq("client_id", lead.client_id)
      .eq("status", "approved")
      .maybeSingle();
    const stages = ((pb as { sales_process?: SalesProcessStage[] } | null)?.sales_process ?? []) as SalesProcessStage[];
    if (stages.length === 0) {
      return { ok: false, error: "Client has no approved playbook with sales_process stages" };
    }

    const currentIdx = lead.process_stage_id
      ? stages.findIndex((s) => s.id === lead.process_stage_id)
      : -1;
    if (currentIdx === -1) {
      return { ok: false, error: "Lead is not on a sales-process stage" };
    }
    const currentStage = stages[currentIdx];
    if (!isHumanStage(currentStage.agent)) {
      return { ok: false, error: `Current stage "${currentStage.name}" is not human-owned — nothing to mark complete.` };
    }
    if (currentStage.id === HAVE_MEETING_STAGE_ID && !opts.allowHaveMeeting) {
      return {
        ok: false,
        error: "Have Meeting completion requires meeting notes — open the post-meeting form.",
      };
    }

    const nextStage = stages[currentIdx + 1] ?? null;
    const nextStageId = nextStage?.id ?? null;
    const nextIsHuman = nextStage ? isHumanStage(nextStage.agent) : false;

    // Advance lead to next stage (or stay put if this was the last one)
    if (nextStageId) {
      const { error } = await supabase
        .from("leads")
        .update({ process_stage_id: nextStageId })
        .eq("id", leadId);
      if (error) return { ok: false, error: error.message };
    }

    // Resolve any open human_stage_task approval for this stage.
    await supabase
      .from("approvals")
      .update({
        status: "approved",
        approved_by: user.auth.id,
        decided_at: new Date().toISOString(),
      })
      .eq("client_id", lead.client_id)
      .eq("type", "human_stage_task")
      .eq("status", "pending")
      .filter("payload->>stage_id", "eq", currentStage.id)
      .filter("payload->>lead_id", "eq", leadId);

    await logEvent({
      event_type: "stage_changed",
      lead_id: leadId,
      client_id: lead.client_id,
      user_id: user.auth.id,
      payload: {
        kind: "human_stage_completed",
        lead_name: lead.company_name,
        completed_stage_id: currentStage.id,
        completed_stage_name: currentStage.name,
        next_stage_id: nextStageId,
        next_stage_agent: nextStage?.agent ?? null,
        message: nextStage
          ? `${currentStage.name} marked complete. Advanced to ${nextStage.name}${nextIsHuman ? " (also human)" : ` (handed to ${nextStage.agent})`}.`
          : `${currentStage.name} marked complete. End of pipeline.`,
      },
    });

    revalidatePath(`/leads/${leadId}`);
    revalidatePath("/leads");
    revalidatePath("/approvals");
    revalidatePath("/dashboard");
    return { ok: true, next_stage_id: nextStageId, next_is_human: nextIsHuman };
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
 * playbook strategy + voice + the meeting context), creates a
 * proposal_review approval so HOS can review/edit/send it, then advances the
 * lead from "Have meeting" to "Send proposal" (and resolves the open
 * human_stage_task approval for Have Meeting).
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

    // 1. Save meeting note (without related_approval_id yet — we'll patch it
    // back once the approval is created below).
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

    // 2. Draft a follow-up proposal via Claude (graceful when no key)
    const draft = await draftFollowUpProposal({
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

    let approvalId: string | null = null;
    if (data.outcome !== "no_show") {
      const proposalPayload: ProposalReviewPayload = {
        meeting_note_id: noteRow.id,
        drafted_subject: draft.subject,
        drafted_body: draft.body,
        outcome: data.outcome,
        ai_warning: draft.warning ?? null,
      };
      const { data: appr, error: apprErr } = await supabase
        .from("approvals")
        .insert({
          client_id: lead.client_id,
          type: "proposal_review",
          status: "pending",
          title: `${lead.company_name}: review proposal draft`,
          summary: `Post-meeting follow-up (${data.outcome}). Claude drafted a proposal — review + send.`,
          payload: proposalPayload as unknown as Record<string, unknown>,
          related_playbook_id: playbook?.id ?? null,
          created_by: user.auth.id,
        })
        .select("id")
        .single();
      if (!apprErr && appr) {
        approvalId = appr.id;
        await supabase
          .from("meeting_notes")
          .update({
            related_approval_id: approvalId,
            drafted_proposal_subject: draft.subject,
            drafted_proposal_body: draft.body,
          })
          .eq("id", noteRow.id);
      } else {
        console.error("[meeting-notes] proposal_review approval create failed", apprErr);
      }
    }

    // 3. Resolve the open human_stage_task approval for Have Meeting
    await supabase
      .from("approvals")
      .update({
        status: "approved",
        approved_by: user.auth.id,
        decided_at: new Date().toISOString(),
      })
      .eq("client_id", lead.client_id)
      .eq("type", "human_stage_task")
      .eq("status", "pending")
      .filter("payload->>stage_id", "eq", currentStage.id)
      .filter("payload->>lead_id", "eq", lead.id);

    // 4. Advance lead to next stage
    if (nextStage) {
      await supabase
        .from("leads")
        .update({ process_stage_id: nextStage.id })
        .eq("id", lead.id);
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
 * timeline). If the destination stage is owned by a human agent, also log a
 * `human_handoff_required` event so HOS sees the task on the dashboard.
 */
export async function moveLeadToProcessStage(
  leadId: string,
  stageId: string,
): Promise<ActionResult> {
  try {
    const user = await requireUser();
    const supabase = createClient();

    const { data: lead } = await supabase
      .from("leads")
      .select("client_id, process_stage_id, company_name, contact_name")
      .eq("id", leadId)
      .maybeSingle();
    if (!lead) return { ok: false, error: "Lead not found" };

    // Look up the stage definition from the client's approved playbook
    let stage: SalesProcessStage | null = null;
    if (lead.client_id) {
      const { data: pb } = await supabase
        .from("playbooks")
        .select("sales_process")
        .eq("client_id", lead.client_id)
        .eq("status", "approved")
        .maybeSingle();
      const stages = (pb as { sales_process?: SalesProcessStage[] } | null)?.sales_process ?? [];
      stage = stages.find((s) => s.id === stageId) ?? null;
    }

    const before = lead.process_stage_id;
    const { error } = await supabase
      .from("leads")
      .update({ process_stage_id: stageId })
      .eq("id", leadId);
    if (error) return { ok: false, error: error.message };

    await logEvent({
      event_type: "stage_changed",
      lead_id: leadId,
      client_id: lead.client_id,
      user_id: user.auth.id,
      payload: {
        kind: "process_stage_moved",
        lead_name: lead.company_name,
        before,
        after: stageId,
        stage_name: stage?.name ?? stageId,
        agent: stage?.agent ?? null,
      },
    });

    if (stage && isHumanStage(stage.agent)) {
      // Pause outreach: cancel all pending emails for this lead while
      // they sit in a human-owned stage. They get re-queued (if at all)
      // when the lead advances back into an agent-owned stage.
      await supabase
        .from("emails")
        .update({ status: "failed" })
        .eq("lead_id", leadId)
        .eq("status", "pending");

      // Per-stage approval: create a human_stage_task approval row each
      // time a lead enters a human-owned stage. The Mark Complete action
      // auto-resolves it. Skip if there's already an open task for this
      // exact (lead, stage) — re-runs shouldn't pile up duplicates.
      // (Approvals require a client_id; orphaned leads skip the task row.)
      if (lead.client_id) {
        const { data: existingTask } = await supabase
          .from("approvals")
          .select("id")
          .eq("type", "human_stage_task")
          .eq("status", "pending")
          .eq("client_id", lead.client_id)
          .filter("payload->>stage_id", "eq", stage.id)
          .filter("payload->>lead_id", "eq", leadId)
          .limit(1)
          .maybeSingle();
        if (!existingTask) {
          await supabase.from("approvals").insert({
            client_id: lead.client_id,
            type: "human_stage_task",
            status: "pending",
            title: `${lead.company_name}: ${stage.name}`,
            summary: `Lead reached a human-owned stage. Automation paused — HOS to mark the stage complete.`,
            payload: {
              stage_id: stage.id,
              stage_name: stage.name,
              agent: stage.agent,
              lead_id: leadId,
              message: `Lead reached "${stage.name}" — automation paused, awaiting human action.`,
            } as Record<string, unknown>,
            created_by: user.auth.id,
          });
        }
      }

      await logEvent({
        event_type: "ai_action",
        lead_id: leadId,
        client_id: lead.client_id,
        user_id: user.auth.id,
        payload: {
          kind: "human_handoff_required",
          lead_name: lead.company_name,
          stage_name: stage.name,
          stage_id: stage.id,
          message: `Lead reached "${stage.name}" — automation paused, awaiting human action. HOS to mark complete to advance.`,
        },
      });
    }

    revalidatePath(`/leads/${leadId}`);
    revalidatePath("/leads");
    revalidatePath("/dashboard");
    return { ok: true };
  } catch (err) {
    return actionError(err);
  }
}
