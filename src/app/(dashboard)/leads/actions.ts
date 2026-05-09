"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { requireUser } from "@/lib/auth";
import { logEvent } from "@/lib/events";
import { actionError, type ActionResult } from "@/lib/actions";
import type { LeadStage, Playbook, SalesProcessStage } from "@/lib/supabase/types";
import { isHumanStage } from "@/lib/playbook-defaults";

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
 * accidental clicks on a non-human stage are no-ops).
 */
export async function markHumanStageComplete(leadId: string): Promise<ActionResult<{ next_stage_id: string | null; next_is_human: boolean }>> {
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
    revalidatePath("/dashboard");
    return { ok: true, next_stage_id: nextStageId, next_is_human: nextIsHuman };
  } catch (err) {
    return actionError(err);
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
