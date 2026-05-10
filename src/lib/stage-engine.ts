/**
 * Stage engine — single source of truth for moving a lead through the
 * sales-process. Every stage transition (manual move, mark-complete,
 * post-meeting submit, backfill) routes through `transitionLeadToStage`.
 *
 * The engine handles ALL side effects of a transition:
 *   1. Update leads.process_stage_id
 *   2. Log a `stage_changed` event
 *   3. If destination owner = 'human' → cancel pending emails, open a
 *      `human_stage_task` approval (deduped per lead × stage)
 *   4. If destination is the Send Proposal stage → open a `proposal_review`
 *      approval (deduped per lead, with a placeholder draft if no caller
 *      context was supplied)
 *
 * Callers (server actions, scripts) should never write process_stage_id or
 * approval rows directly — go through this module instead.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { isHumanStage } from "@/lib/playbook-defaults";
import { logEvent } from "@/lib/events";
import type {
  Database,
  HumanStageTaskPayload,
  Playbook,
  ProposalReviewPayload,
  SalesProcessStage,
} from "@/lib/supabase/types";

type Supa = SupabaseClient<Database>;

/** The canonical Send-Proposal stage id used by DEFAULT_SALES_PROCESS. The
 *  engine triggers proposal_review auto-creation when the lead enters this
 *  stage. */
export const SEND_PROPOSAL_STAGE_ID = "send_proposal";

export type ProposalDraftContext = {
  /** Optional ref into meeting_notes when the transition is post-meeting. */
  meeting_note_id?: string | null;
  drafted_subject: string;
  drafted_body: string;
  outcome?: ProposalReviewPayload["outcome"];
  source: ProposalReviewPayload["source"];
  ai_warning?: string | null;
};

export type TransitionOpts = {
  /** Who triggered the transition. Stored on the event + approval rows. */
  userId?: string | null;
  /** Optional override for the proposal_review draft, only used when the
   *  destination is `send_proposal`. When omitted the engine creates a
   *  placeholder approval HOS can edit before sending. */
  proposalContext?: ProposalDraftContext;
  /** Use the service role to bypass RLS (cron / scripts). */
  service?: boolean;
};

export type TransitionResult = {
  ok: true;
  lead_id: string;
  from_stage_id: string | null;
  to_stage_id: string;
  to_stage_name: string;
  to_stage_agent: string;
  human_task_approval_id: string | null;
  proposal_review_approval_id: string | null;
};

export type TransitionFailure = { ok: false; error: string };

/**
 * Move a lead to `toStageId` and run every side effect that the destination
 * stage demands. Idempotent on the side effects (won't double-create a
 * human_stage_task or proposal_review for the same lead × stage).
 */
export async function transitionLeadToStage(
  supabase: Supa,
  leadId: string,
  toStageId: string,
  opts: TransitionOpts = {},
): Promise<TransitionResult | TransitionFailure> {
  // 1. Resolve lead + playbook
  const { data: leadRow } = await supabase
    .from("leads")
    .select("id, client_id, process_stage_id, company_name, contact_name, stage")
    .eq("id", leadId)
    .maybeSingle();
  if (!leadRow) return { ok: false, error: "Lead not found" };
  const lead = leadRow as {
    id: string;
    client_id: string | null;
    process_stage_id: string | null;
    company_name: string;
    contact_name: string | null;
    stage: string;
  };

  let stages: SalesProcessStage[] = [];
  let playbookId: string | null = null;
  if (lead.client_id) {
    const { data: pbRow } = await supabase
      .from("playbooks")
      .select("id, sales_process")
      .eq("client_id", lead.client_id)
      .eq("status", "approved")
      .maybeSingle();
    const pb = pbRow as Pick<Playbook, "id" | "sales_process"> | null;
    stages = (pb?.sales_process ?? []) as SalesProcessStage[];
    playbookId = pb?.id ?? null;
  }

  const toStage = stages.find((s) => s.id === toStageId) ?? null;
  if (!toStage) {
    return {
      ok: false,
      error: `Stage "${toStageId}" not found in client's approved playbook`,
    };
  }

  const fromStageId = lead.process_stage_id;

  // 2. Persist the move (only if it actually changes)
  if (fromStageId !== toStageId) {
    const { error } = await supabase
      .from("leads")
      .update({ process_stage_id: toStageId })
      .eq("id", leadId);
    if (error) return { ok: false, error: error.message };
  }

  // 3. Log the transition
  await logEvent({
    service: opts.service,
    event_type: "stage_changed",
    lead_id: leadId,
    client_id: lead.client_id,
    user_id: opts.userId ?? null,
    payload: {
      kind: "stage_engine_transition",
      lead_name: lead.company_name,
      before: fromStageId,
      after: toStageId,
      stage_name: toStage.name,
      agent: toStage.agent,
    },
  });

  // 4. Owner-specific side effects
  let humanTaskId: string | null = null;
  let proposalReviewId: string | null = null;

  if (isHumanStage(toStage.agent)) {
    const r = await ensureHumanStageTask(supabase, {
      lead,
      stage: toStage,
      userId: opts.userId,
    });
    if (!r.ok) return r;
    humanTaskId = r.approvalId;

    // Pause outreach while the lead sits at a human stage.
    await supabase
      .from("emails")
      .update({ status: "failed" })
      .eq("lead_id", leadId)
      .eq("status", "pending");
  } else if (toStage.id === SEND_PROPOSAL_STAGE_ID) {
    const r = await ensureProposalReview(supabase, {
      lead,
      playbookId,
      userId: opts.userId,
      proposalContext: opts.proposalContext,
    });
    if (!r.ok) return r;
    proposalReviewId = r.approvalId;
  }

  return {
    ok: true,
    lead_id: leadId,
    from_stage_id: fromStageId,
    to_stage_id: toStageId,
    to_stage_name: toStage.name,
    to_stage_agent: toStage.agent,
    human_task_approval_id: humanTaskId,
    proposal_review_approval_id: proposalReviewId,
  };
}

/**
 * HOS marks the lead's CURRENT human-owned stage complete and the lead
 * advances to the next stage in the playbook. The current stage's
 * `human_stage_task` approval is resolved as `approved`.
 *
 * Refuses to run if the current stage isn't human-owned.
 */
export async function markCurrentStageComplete(
  supabase: Supa,
  leadId: string,
  opts: { userId?: string | null; allowedStageId?: string } = {},
): Promise<
  | {
      ok: true;
      from_stage_id: string;
      to_stage_id: string | null;
      transition?: TransitionResult;
    }
  | TransitionFailure
> {
  const { data: leadRow } = await supabase
    .from("leads")
    .select("id, client_id, process_stage_id, company_name")
    .eq("id", leadId)
    .maybeSingle();
  if (!leadRow) return { ok: false, error: "Lead not found" };
  const lead = leadRow as {
    id: string;
    client_id: string | null;
    process_stage_id: string | null;
    company_name: string;
  };
  if (!lead.client_id) return { ok: false, error: "Lead has no client" };
  if (!lead.process_stage_id) {
    return { ok: false, error: "Lead is not on a sales-process stage" };
  }
  if (opts.allowedStageId && lead.process_stage_id !== opts.allowedStageId) {
    return {
      ok: false,
      error: `Lead's current stage doesn't match the requested one (${opts.allowedStageId}).`,
    };
  }

  const { data: pbRow } = await supabase
    .from("playbooks")
    .select("sales_process")
    .eq("client_id", lead.client_id)
    .eq("status", "approved")
    .maybeSingle();
  const stages = ((pbRow as { sales_process?: SalesProcessStage[] } | null)?.sales_process ??
    []) as SalesProcessStage[];
  const idx = stages.findIndex((s) => s.id === lead.process_stage_id);
  if (idx === -1) {
    return { ok: false, error: "Lead's stage isn't in the playbook" };
  }
  const currentStage = stages[idx];
  if (!isHumanStage(currentStage.agent)) {
    return {
      ok: false,
      error: `Current stage "${currentStage.name}" is not human-owned — nothing to mark complete.`,
    };
  }

  // Resolve the open human_stage_task for this (lead, stage)
  await supabase
    .from("approvals")
    .update({
      status: "approved",
      approved_by: opts.userId ?? null,
      decided_at: new Date().toISOString(),
    })
    .eq("client_id", lead.client_id)
    .eq("type", "human_stage_task")
    .eq("status", "pending")
    .filter("payload->>stage_id", "eq", currentStage.id)
    .filter("payload->>lead_id", "eq", leadId);

  const next = stages[idx + 1] ?? null;
  if (!next) {
    await logEvent({
      event_type: "stage_changed",
      lead_id: leadId,
      client_id: lead.client_id,
      user_id: opts.userId ?? null,
      payload: {
        kind: "human_stage_completed_end_of_pipeline",
        completed_stage_id: currentStage.id,
        completed_stage_name: currentStage.name,
        lead_name: lead.company_name,
      },
    });
    return { ok: true, from_stage_id: currentStage.id, to_stage_id: null };
  }

  const transition = await transitionLeadToStage(supabase, leadId, next.id, {
    userId: opts.userId,
  });
  if (!transition.ok) return transition;

  return {
    ok: true,
    from_stage_id: currentStage.id,
    to_stage_id: next.id,
    transition,
  };
}

// ──────────────────────────────────────────────────────────────────────────
// Internal: per-side-effect ensure helpers (idempotent)
// ──────────────────────────────────────────────────────────────────────────

async function ensureHumanStageTask(
  supabase: Supa,
  args: {
    lead: { id: string; client_id: string | null; company_name: string };
    stage: SalesProcessStage;
    userId?: string | null;
  },
): Promise<{ ok: true; approvalId: string | null } | TransitionFailure> {
  const { lead, stage, userId } = args;
  if (!lead.client_id) {
    // Approvals require a client_id; orphaned leads silently skip.
    return { ok: true, approvalId: null };
  }

  const { data: existing } = await supabase
    .from("approvals")
    .select("id")
    .eq("type", "human_stage_task")
    .eq("status", "pending")
    .eq("client_id", lead.client_id)
    .filter("payload->>stage_id", "eq", stage.id)
    .filter("payload->>lead_id", "eq", lead.id)
    .limit(1)
    .maybeSingle();
  if (existing) return { ok: true, approvalId: (existing as { id: string }).id };

  const payload: HumanStageTaskPayload & { lead_id: string } = {
    stage_id: stage.id,
    stage_name: stage.name,
    agent: stage.agent,
    lead_id: lead.id,
    message: `Lead reached "${stage.name}" — automation paused, awaiting human action.`,
  };

  const { data: created, error } = await supabase
    .from("approvals")
    .insert({
      client_id: lead.client_id,
      type: "human_stage_task",
      status: "pending",
      title: `${lead.company_name}: ${stage.name}`,
      summary: `Lead reached a human-owned stage. Automation paused — HOS to mark the stage complete.`,
      payload: payload as unknown as Record<string, unknown>,
      created_by: userId ?? null,
    })
    .select("id")
    .single();
  if (error || !created) {
    return { ok: false, error: error?.message ?? "Failed to create human_stage_task" };
  }
  return { ok: true, approvalId: (created as { id: string }).id };
}

async function ensureProposalReview(
  supabase: Supa,
  args: {
    lead: { id: string; client_id: string | null; company_name: string; contact_name: string | null };
    playbookId: string | null;
    userId?: string | null;
    proposalContext?: ProposalDraftContext;
  },
): Promise<{ ok: true; approvalId: string | null } | TransitionFailure> {
  const { lead, playbookId, userId, proposalContext } = args;
  if (!lead.client_id) return { ok: true, approvalId: null };

  // Dedup per lead — never two open proposal_reviews for the same lead.
  const { data: existing } = await supabase
    .from("approvals")
    .select("id")
    .eq("type", "proposal_review")
    .eq("status", "pending")
    .eq("client_id", lead.client_id)
    .filter("payload->>lead_id", "eq", lead.id)
    .limit(1)
    .maybeSingle();
  if (existing) return { ok: true, approvalId: (existing as { id: string }).id };

  const draft: ProposalReviewPayload = proposalContext
    ? {
        lead_id: lead.id,
        meeting_note_id: proposalContext.meeting_note_id ?? null,
        drafted_subject: proposalContext.drafted_subject,
        drafted_body: proposalContext.drafted_body,
        outcome: proposalContext.outcome ?? null,
        source: proposalContext.source,
        ai_warning: proposalContext.ai_warning ?? null,
      }
    : {
        lead_id: lead.id,
        meeting_note_id: null,
        drafted_subject: `Proposal for ${lead.company_name}`,
        drafted_body: `Hi ${lead.contact_name?.split(" ")[0] ?? "there"},\n\n[Draft your proposal here. Lead reached the Send Proposal stage but no meeting-notes context was supplied — write the proposal manually before sending.]\n\nThanks,\nAylek Sales`,
        outcome: null,
        source: "auto_on_send_proposal",
        ai_warning: null,
      };

  const { data: created, error } = await supabase
    .from("approvals")
    .insert({
      client_id: lead.client_id,
      type: "proposal_review",
      status: "pending",
      title: `${lead.company_name}: review proposal draft`,
      summary: proposalContext
        ? `Post-meeting follow-up draft. Review + send.`
        : `Lead reached Send Proposal — draft a proposal and send.`,
      payload: draft as unknown as Record<string, unknown>,
      related_playbook_id: playbookId,
      created_by: userId ?? null,
    })
    .select("id")
    .single();
  if (error || !created) {
    return { ok: false, error: error?.message ?? "Failed to create proposal_review" };
  }
  return { ok: true, approvalId: (created as { id: string }).id };
}
