"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { requireUser } from "@/lib/auth";
import { logEvent } from "@/lib/events";
import { actionError, type ActionResult } from "@/lib/actions";
import { resend, FROM_EMAIL } from "@/lib/resend";
import { getClientSendingConfig } from "@/lib/email-config";
import { spawnOnboardingSession } from "@/lib/onboarding-trigger";
import type {
  Approval,
  LeadListPayload,
  Playbook,
  PlaybookSequenceStep,
  StrategyChangePayload,
} from "@/lib/supabase/types";

const ApproveSchema = z.object({
  id: z.string().uuid(),
  /**
   * Optional override for lead_list approvals where the payload doesn't
   * already carry a campaign_id. The HOS picks one in the approval card.
   */
  campaign_id: z.string().uuid().optional(),
  /**
   * Optional: create a new campaign on the fly when there's no existing one
   * for the client. The new campaign uses the client's approved playbook
   * sequence, so the DB hard gate is satisfied automatically.
   */
  new_campaign: z
    .object({
      name: z.string().min(1).max(120),
    })
    .optional(),
  /**
   * Optional: when only a subset of the batch should be enrolled (after
   * per-lead reject decisions), pass the subset here. Defaults to all
   * lead_ids in the approval payload.
   */
  only_lead_ids: z.array(z.string().uuid()).optional(),
});

const RejectSchema = z.object({
  id: z.string().uuid(),
  reason: z.string().max(1000).optional(),
});

/**
 * Approve a pending approval row.
 *  - lead_list: enrol payload.lead_ids into payload.campaign_id (queues step-1 emails)
 *  - strategy_change in mode='promote_draft': flip playbook from pending_approval → approved,
 *      demote any other approved playbook for the same client to draft.
 *  - strategy_change in mode='diff': apply patch to current approved playbook,
 *      bump version, snapshot via DB trigger.
 */
export async function approveApproval(input: unknown): Promise<ActionResult> {
  try {
    const user = await requireUser();
    const parsed = ApproveSchema.safeParse(input);
    if (!parsed.success) return { ok: false, error: "Invalid id" };

    const supabase = createClient();
    const { data: approvalRow } = await supabase
      .from("approvals")
      .select("*")
      .eq("id", parsed.data.id)
      .maybeSingle();
    if (!approvalRow) return { ok: false, error: "Approval not found" };
    const approval = approvalRow as Approval;
    if (approval.status !== "pending") {
      return { ok: false, error: `Already ${approval.status}` };
    }

    let summaryForLog: Record<string, unknown> = {};

    if (approval.type === "lead_list") {
      const r = await applyLeadListApproval(approval, user.auth.id, {
        campaignId: parsed.data.campaign_id,
        newCampaignName: parsed.data.new_campaign?.name,
        onlyLeadIds: parsed.data.only_lead_ids,
      });
      if (!r.ok) return r;
      summaryForLog = { kind: "lead_list_approved", ...r.summary };
    } else if (approval.type === "strategy_change") {
      const r = await applyStrategyChangeApproval(approval, user.auth.id);
      if (!r.ok) return r;
      summaryForLog = { kind: "strategy_change_approved", ...r.summary };
    } else if (approval.type === "playbook_approval") {
      const r = await applyPlaybookApproval(approval, user.auth.id);
      if (!r.ok) return r;
      summaryForLog = { kind: "playbook_approval_approved", ...r.summary };
    } else {
      return { ok: false, error: `Unknown approval type: ${approval.type}` };
    }

    const decidedAt = new Date().toISOString();
    const { error: updErr } = await supabase
      .from("approvals")
      .update({
        status: "approved",
        approved_by: user.auth.id,
        decided_at: decidedAt,
      })
      .eq("id", approval.id);
    if (updErr) return { ok: false, error: updErr.message };

    await logEvent({
      event_type: "ai_action",
      client_id: approval.client_id,
      user_id: user.auth.id,
      payload: {
        ...summaryForLog,
        approval_id: approval.id,
        approval_title: approval.title,
      },
    });

    revalidatePath("/approvals");
    revalidatePath("/dashboard");
    revalidatePath("/playbooks");
    revalidatePath("/leads");
    revalidatePath("/campaigns");
    return { ok: true };
  } catch (err) {
    return actionError(err);
  }
}

export async function rejectApproval(input: unknown): Promise<ActionResult> {
  try {
    const user = await requireUser();
    const parsed = RejectSchema.safeParse(input);
    if (!parsed.success) return { ok: false, error: "Invalid input" };

    const supabase = createClient();
    const { data: approvalRow } = await supabase
      .from("approvals")
      .select("*")
      .eq("id", parsed.data.id)
      .maybeSingle();
    if (!approvalRow) return { ok: false, error: "Approval not found" };
    const approval = approvalRow as Approval;
    if (approval.status !== "pending") {
      return { ok: false, error: `Already ${approval.status}` };
    }

    // If we're rejecting a playbook submission, return it to draft so HOS can edit + resubmit.
    if (
      approval.type === "strategy_change" &&
      (approval.payload as StrategyChangePayload & { mode?: string })?.mode === "promote_draft" &&
      approval.related_playbook_id
    ) {
      await supabase
        .from("playbooks")
        .update({ status: "draft" })
        .eq("id", approval.related_playbook_id);
    }

    const { error } = await supabase
      .from("approvals")
      .update({
        status: "rejected",
        approved_by: user.auth.id,
        decided_at: new Date().toISOString(),
      })
      .eq("id", approval.id);
    if (error) return { ok: false, error: error.message };

    await logEvent({
      event_type: "ai_action",
      client_id: approval.client_id,
      user_id: user.auth.id,
      payload: {
        kind: "approval_rejected",
        approval_id: approval.id,
        approval_title: approval.title,
        reason: parsed.data.reason ?? null,
      },
    });

    revalidatePath("/approvals");
    revalidatePath("/dashboard");
    revalidatePath("/playbooks");
    return { ok: true };
  } catch (err) {
    return actionError(err);
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Proposal review decisions (post-meeting drafted email)
// ──────────────────────────────────────────────────────────────────────────

const ProposalReviewSchema = z.object({
  approval_id: z.string().uuid(),
  /** Optional HOS edits — if supplied, override the AI draft. */
  edited_subject: z.string().min(1).max(200).optional(),
  edited_body: z.string().min(1).max(20000).optional(),
});

/**
 * HOS approves a proposal_review approval. Sends the (possibly edited)
 * proposal email via Resend to the lead, records an outbound email row,
 * marks the approval approved. Used by the Approve & Send button on the
 * proposal_review card.
 */
export async function approveProposalReview(
  input: unknown,
): Promise<ActionResult<{ email_id: string | null }>> {
  try {
    const user = await requireUser();
    const parsed = ProposalReviewSchema.safeParse(input);
    if (!parsed.success) return { ok: false, error: "Invalid input" };
    const supabase = createClient();

    const { data: apprRow } = await supabase
      .from("approvals")
      .select("*")
      .eq("id", parsed.data.approval_id)
      .maybeSingle();
    if (!apprRow) return { ok: false, error: "Approval not found" };
    const approval = apprRow as Approval;
    if (approval.type !== "proposal_review") {
      return { ok: false, error: "Not a proposal_review approval" };
    }
    if (approval.status !== "pending") {
      return { ok: false, error: `Already ${approval.status}` };
    }

    const payload = (approval.payload ?? {}) as Partial<{
      lead_id: string;
      meeting_note_id: string | null;
      drafted_subject: string;
      drafted_body: string;
    }>;
    const subject = parsed.data.edited_subject ?? payload.drafted_subject ?? "";
    const body = parsed.data.edited_body ?? payload.drafted_body ?? "";
    if (!subject || !body) {
      return { ok: false, error: "Subject and body are required to send." };
    }

    // Resolve the lead. Prefer payload.lead_id (always present on approvals
    // created by the stage engine). Fall back to a meeting_notes join for
    // legacy rows that only carry meeting_note_id.
    let leadIdResolved: string | null = payload.lead_id ?? null;
    let leadEmail: string | null = null;
    let leadClientId: string | null = null;
    let leadContactName: string | null = null;
    if (leadIdResolved) {
      const { data: leadRow } = await supabase
        .from("leads")
        .select("id, email, client_id, contact_name")
        .eq("id", leadIdResolved)
        .maybeSingle();
      const lead = leadRow as
        | { id: string; email: string | null; client_id: string | null; contact_name: string | null }
        | null;
      if (!lead) return { ok: false, error: "Lead not found for this approval." };
      leadEmail = lead.email;
      leadClientId = lead.client_id;
      leadContactName = lead.contact_name;
    } else if (payload.meeting_note_id) {
      const { data: noteRow } = await supabase
        .from("meeting_notes")
        .select("lead_id, client_id, leads(email, contact_name)")
        .eq("id", payload.meeting_note_id)
        .maybeSingle();
      const note = noteRow as
        | {
            lead_id: string;
            client_id: string | null;
            leads: { email: string | null; contact_name: string | null } | null;
          }
        | null;
      if (!note) return { ok: false, error: "Meeting note not found for this approval." };
      leadIdResolved = note.lead_id;
      leadEmail = note.leads?.email ?? null;
      leadClientId = note.client_id;
      leadContactName = note.leads?.contact_name ?? null;
    } else {
      return { ok: false, error: "Approval has no lead reference." };
    }
    if (!leadEmail) {
      return { ok: false, error: "Lead has no email address — cannot send." };
    }
    const note = {
      lead_id: leadIdResolved,
      client_id: leadClientId,
      leads: { email: leadEmail },
    };

    // Send via Resend — use the per-client verified domain when set.
    const sendingCfg = await getClientSendingConfig(supabase, note.client_id);
    let resendId: string | null = null;
    try {
      const result = await resend.emails.send({
        from: sendingCfg.from,
        to: note.leads.email,
        subject,
        text: body,
        replyTo: sendingCfg.reply_to,
      });
      if (result.error) throw new Error(result.error.message);
      resendId = result.data?.id ?? null;
    } catch (sendErr) {
      const msg = sendErr instanceof Error ? sendErr.message : String(sendErr);
      return { ok: false, error: `Resend send failed: ${msg}` };
    }

    // Record the outbound email + mark approval approved
    const now = new Date().toISOString();
    const { data: emailRow } = await supabase
      .from("emails")
      .insert({
        lead_id: note.lead_id,
        client_id: note.client_id,
        direction: "outbound" as const,
        subject,
        body,
        status: "sent" as const,
        sent_at: now,
        resend_message_id: resendId,
      })
      .select("id")
      .single();

    await supabase
      .from("approvals")
      .update({
        status: "approved",
        approved_by: user.auth.id,
        decided_at: now,
      })
      .eq("id", approval.id);

    await logEvent({
      event_type: "email_sent",
      lead_id: note.lead_id,
      client_id: note.client_id,
      payload: {
        kind: "proposal_sent",
        approval_id: approval.id,
        meeting_note_id: payload.meeting_note_id,
        subject,
      },
    });

    // After the proposal lands, spawn the client onboarding interview. The
    // contact gets a private /onboard/[token] link to fill out the playbook
    // interview. Idempotent: a single in-flight session per (client, lead).
    if (note.client_id && note.lead_id) {
      const { data: clientRow } = await supabase
        .from("clients")
        .select("name")
        .eq("id", note.client_id)
        .maybeSingle();
      const clientName = (clientRow as { name?: string } | null)?.name ?? "your team";
      const onboard = await spawnOnboardingSession(supabase, {
        clientId: note.client_id,
        leadId: note.lead_id,
        contactEmail: note.leads.email,
        contactName: leadContactName,
        clientName,
        userId: user.auth.id,
      });
      if (!onboard.ok) {
        console.error("[approvals] onboarding spawn failed", onboard.error);
      }
    }

    revalidatePath("/approvals");
    revalidatePath(`/leads/${note.lead_id}`);
    revalidatePath(`/clients/${note.client_id}`);
    revalidatePath("/dashboard");
    return { ok: true, email_id: (emailRow as { id?: string } | null)?.id ?? null };
  } catch (err) {
    return actionError(err);
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Reply review decisions (inbound auto-classifier draft)
// ──────────────────────────────────────────────────────────────────────────

const ReplyReviewSchema = z.object({
  approval_id: z.string().uuid(),
  edited_subject: z.string().min(1).max(200).optional(),
  edited_body: z.string().min(1).max(20000).optional(),
});

/**
 * HOS approves a reply_review approval. Sends the (possibly edited)
 * drafted response via Resend (per-client sending domain), records the
 * outbound email row, marks the approval approved. Used by the Approve
 * & Send button on the reply_review card.
 */
export async function approveReplyReview(
  input: unknown,
): Promise<ActionResult<{ email_id: string | null }>> {
  try {
    const user = await requireUser();
    const parsed = ReplyReviewSchema.safeParse(input);
    if (!parsed.success) return { ok: false, error: "Invalid input" };
    const supabase = createClient();

    const { data: apprRow } = await supabase
      .from("approvals")
      .select("*")
      .eq("id", parsed.data.approval_id)
      .maybeSingle();
    if (!apprRow) return { ok: false, error: "Approval not found" };
    const approval = apprRow as Approval;
    if (approval.type !== "reply_review") {
      return { ok: false, error: "Not a reply_review approval" };
    }
    if (approval.status !== "pending") {
      return { ok: false, error: `Already ${approval.status}` };
    }

    const payload = (approval.payload ?? {}) as Partial<{
      lead_id: string;
      drafted_subject: string;
      drafted_body: string;
      incoming_subject: string | null;
    }>;
    const subject = parsed.data.edited_subject ?? payload.drafted_subject ?? "";
    const body = parsed.data.edited_body ?? payload.drafted_body ?? "";
    if (!payload.lead_id || !subject || !body) {
      return { ok: false, error: "Approval has no lead / subject / body." };
    }

    // Find the lead's email + client.
    const { data: leadRow } = await supabase
      .from("leads")
      .select("id, email, client_id")
      .eq("id", payload.lead_id)
      .maybeSingle();
    const lead = leadRow as
      | { id: string; email: string | null; client_id: string | null }
      | null;
    if (!lead?.email) {
      return { ok: false, error: "Lead has no email address — cannot send." };
    }

    const sendingCfg = await getClientSendingConfig(supabase, lead.client_id);
    const finalSubject = subject.startsWith("Re:")
      ? subject
      : payload.incoming_subject
        ? `Re: ${payload.incoming_subject.replace(/^Re:\s*/i, "")}`
        : subject;

    let resendId: string | null = null;
    try {
      const result = await resend.emails.send({
        from: sendingCfg.from,
        to: lead.email,
        subject: finalSubject,
        text: body,
        replyTo: sendingCfg.reply_to,
      });
      if (result.error) throw new Error(result.error.message);
      resendId = result.data?.id ?? null;
    } catch (sendErr) {
      const msg = sendErr instanceof Error ? sendErr.message : String(sendErr);
      return { ok: false, error: `Resend send failed: ${msg}` };
    }

    const now = new Date().toISOString();
    const { data: emailRow } = await supabase
      .from("emails")
      .insert({
        lead_id: lead.id,
        client_id: lead.client_id,
        direction: "outbound" as const,
        subject: finalSubject,
        body,
        status: "sent" as const,
        sent_at: now,
        resend_message_id: resendId,
      })
      .select("id")
      .single();

    await supabase
      .from("approvals")
      .update({ status: "approved", approved_by: user.auth.id, decided_at: now })
      .eq("id", approval.id);

    await logEvent({
      event_type: "email_sent",
      lead_id: lead.id,
      client_id: lead.client_id,
      payload: { kind: "reply_sent", approval_id: approval.id, subject: finalSubject },
    });

    revalidatePath("/approvals");
    revalidatePath(`/leads/${lead.id}`);
    revalidatePath("/dashboard");
    return { ok: true, email_id: (emailRow as { id?: string } | null)?.id ?? null };
  } catch (err) {
    return actionError(err);
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Per-lead decisions inside a lead_list approval
// ──────────────────────────────────────────────────────────────────────────

const PerLeadSchema = z.object({
  approval_id: z.string().uuid(),
  lead_id: z.string().uuid(),
});

/**
 * Approve a single lead inside a lead_list approval batch (for the inline
 * Approve buttons on /leads?approval=<id>). Sets that lead's
 * approval_status='approved'. If every lead in the batch is now decided
 * (approved or rejected), automatically finalises the parent approval —
 * enrolling the approved subset into the linked campaign.
 */
export async function approveLeadInBatch(input: unknown): Promise<ActionResult<{ batch_finalised: boolean }>> {
  return decideLeadInBatch(input, "approved");
}

/**
 * Reject a single lead inside a lead_list approval batch. Sets that lead's
 * approval_status='rejected'. Same auto-finalisation rule as approve.
 */
export async function rejectLeadInBatch(input: unknown): Promise<ActionResult<{ batch_finalised: boolean }>> {
  return decideLeadInBatch(input, "rejected");
}

async function decideLeadInBatch(
  input: unknown,
  decision: "approved" | "rejected",
): Promise<ActionResult<{ batch_finalised: boolean }>> {
  try {
    const user = await requireUser();
    const parsed = PerLeadSchema.safeParse(input);
    if (!parsed.success) return { ok: false, error: "Invalid input" };
    const supabase = createClient();

    // Confirm the approval exists, is pending, and the lead is in its batch
    const { data: apprRow } = await supabase
      .from("approvals")
      .select("*")
      .eq("id", parsed.data.approval_id)
      .maybeSingle();
    if (!apprRow) return { ok: false, error: "Approval not found" };
    const approval = apprRow as Approval;
    if (approval.type !== "lead_list") {
      return { ok: false, error: "Per-lead decisions only apply to lead_list approvals" };
    }
    if (approval.status !== "pending") {
      return { ok: false, error: `Already ${approval.status}` };
    }
    const allLeadIds = (approval.payload as LeadListPayload | null)?.lead_ids ?? [];
    if (!allLeadIds.includes(parsed.data.lead_id)) {
      return { ok: false, error: "Lead is not in this batch" };
    }

    // Flip the single lead
    const { error: updErr } = await supabase
      .from("leads")
      .update({ approval_status: decision })
      .eq("id", parsed.data.lead_id);
    if (updErr) return { ok: false, error: updErr.message };

    await logEvent({
      event_type: "ai_action",
      lead_id: parsed.data.lead_id,
      client_id: approval.client_id,
      user_id: user.auth.id,
      payload: {
        kind: decision === "approved" ? "lead_approved_inline" : "lead_rejected_inline",
        approval_id: approval.id,
      },
    });

    // Now check: are all leads in this batch decided?
    const { data: batchLeads } = await supabase
      .from("leads")
      .select("id, approval_status")
      .in("id", allLeadIds);
    const undecided = (batchLeads ?? []).filter(
      (l) => l.approval_status === "pending_approval",
    );

    let batch_finalised = false;
    if (undecided.length === 0) {
      // All decided — finalise the parent approval. Enrol the approved subset.
      const approvedSubset = (batchLeads ?? [])
        .filter((l) => l.approval_status === "approved")
        .map((l) => l.id);

      if (approvedSubset.length > 0) {
        const r = await applyLeadListApproval(approval, user.auth.id, {
          onlyLeadIds: approvedSubset,
        });
        if (!r.ok) {
          // Don't fail the per-lead decision — but surface the issue.
          console.error("[approvals] auto-finalise failed", r.error);
          return { ok: true, batch_finalised: false };
        }
      }

      // Mark the parent approval as approved regardless of the mix.
      await supabase
        .from("approvals")
        .update({
          status: "approved",
          approved_by: user.auth.id,
          decided_at: new Date().toISOString(),
        })
        .eq("id", approval.id);

      await logEvent({
        event_type: "ai_action",
        client_id: approval.client_id,
        user_id: user.auth.id,
        payload: {
          kind: "lead_list_auto_finalised",
          approval_id: approval.id,
          approved_count: approvedSubset.length,
          rejected_count: allLeadIds.length - approvedSubset.length,
        },
      });
      batch_finalised = true;
    }

    revalidatePath("/leads");
    revalidatePath("/approvals");
    revalidatePath("/dashboard");
    return { ok: true, batch_finalised };
  } catch (err) {
    return actionError(err);
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Internal: apply each type
// ──────────────────────────────────────────────────────────────────────────

async function applyLeadListApproval(
  approval: Approval,
  userId: string,
  override?: { campaignId?: string; newCampaignName?: string; onlyLeadIds?: string[] },
): Promise<ActionResult<{ summary: Record<string, unknown> }>> {
  const supabase = createClient();
  const payload = approval.payload as LeadListPayload;
  if (!payload?.lead_ids?.length) {
    return { ok: false, error: "Approval has no lead_ids in payload" };
  }
  // If a subset was passed (after per-lead rejects), only enrol those.
  const targetLeadIds =
    override?.onlyLeadIds && override.onlyLeadIds.length > 0
      ? override.onlyLeadIds.filter((id) => payload.lead_ids.includes(id))
      : payload.lead_ids;

  // Resolve a campaign:
  //   1. operator-supplied campaign_id (from the approval-card dropdown)
  //   2. operator-requested "new campaign" — create one using the client's
  //      approved playbook sequence
  //   3. fall back to payload.campaign_id (the seeded / agent-set value)
  // If none of those work, return a structured error the UI can use to render
  // a campaign picker rather than a hard block.
  let campaignId = override?.campaignId ?? payload.campaign_id ?? null;

  if (!campaignId && override?.newCampaignName) {
    if (!approval.client_id) {
      return { ok: false, error: "Approval has no client_id — can't create a campaign" };
    }
    const { data: approvedPb } = await supabase
      .from("playbooks")
      .select("sequences")
      .eq("client_id", approval.client_id)
      .eq("status", "approved")
      .maybeSingle();
    if (!approvedPb || !Array.isArray((approvedPb as { sequences?: unknown }).sequences) || ((approvedPb as { sequences?: unknown[] }).sequences ?? []).length === 0) {
      return {
        ok: false,
        error: "Client has no approved playbook with a sequence — approve one first.",
      };
    }
    const { data: created, error: cErr } = await supabase
      .from("campaigns")
      .insert({
        client_id: approval.client_id,
        name: override.newCampaignName,
        status: "draft",
        sequence_steps: (approvedPb as { sequences: PlaybookSequenceStep[] }).sequences,
        created_by: userId,
      })
      .select("id")
      .single();
    if (cErr || !created) {
      return { ok: false, error: cErr?.message ?? "Failed to create campaign" };
    }
    campaignId = created.id;
  }

  if (!campaignId) {
    return {
      ok: false,
      error: "needs_campaign", // UI: render the campaign picker
    };
  }

  // Fetch the campaign + the leads
  const { data: campaignRow } = await supabase
    .from("campaigns")
    .select("*")
    .eq("id", campaignId)
    .maybeSingle();
  if (!campaignRow) return { ok: false, error: "Campaign not found" };
  const campaign = campaignRow as {
    id: string;
    name: string;
    client_id: string | null;
    status: string;
    sequence_steps: PlaybookSequenceStep[] | null;
    leads_enrolled: number;
  };
  if (!Array.isArray(campaign.sequence_steps) || campaign.sequence_steps.length === 0) {
    return { ok: false, error: "Campaign has no sequence steps" };
  }
  const firstStep =
    campaign.sequence_steps.find((s) => s.step === 1) ?? campaign.sequence_steps[0];

  const { data: leads } = await supabase
    .from("leads")
    .select("id, email, company_name, contact_name, stage, client_id")
    .in("id", targetLeadIds);
  const eligible = (leads ?? []).filter(
    (l) => l.email && l.stage !== "unsubscribed" && l.stage !== "won",
  );

  if (eligible.length === 0) {
    return { ok: false, error: "No eligible leads in this approval" };
  }

  const now = new Date().toISOString();
  const emailRows = eligible.map((l) => ({
    lead_id: l.id,
    client_id: campaign.client_id,
    campaign_id: campaign.id,
    direction: "outbound" as const,
    step_number: firstStep.step,
    subject: substitute(firstStep.subject, l),
    body: substitute(firstStep.body, l),
    status: "pending" as const,
    send_at: now,
  }));

  const { error: emailErr } = await supabase.from("emails").insert(emailRows);
  if (emailErr) return { ok: false, error: emailErr.message };

  // Flip every lead in this batch from pending_approval → approved.
  // Done after enrolment so a partial-failure mid-update doesn't leave stale
  // pending leads with no campaign attached. Capture (and log) errors here
  // explicitly — earlier silent swallow let stale pending leads accumulate.
  // Only flip leads we actually enrolled (eligible subset) — rejected leads
  // already had their status set by the per-lead reject path.
  const { error: leadUpdErr } = await supabase
    .from("leads")
    .update({ approval_status: "approved" })
    .in(
      "id",
      eligible.map((l) => l.id),
    );
  if (leadUpdErr) {
    console.error("[approvals] failed to bulk-update lead approval_status", {
      approval_id: approval.id,
      lead_ids: targetLeadIds,
      error: leadUpdErr,
    });
    return {
      ok: false,
      error: `Could not flip leads to approved: ${leadUpdErr.message}`,
    };
  }

  // Activate the campaign if it isn't already (DB hard gate enforces approved playbook).
  if (campaign.status !== "active") {
    const { error: campErr } = await supabase
      .from("campaigns")
      .update({
        status: "active",
        leads_enrolled: (campaign.leads_enrolled ?? 0) + eligible.length,
      })
      .eq("id", campaign.id);
    if (campErr) return { ok: false, error: campErr.message };
  } else {
    await supabase
      .from("campaigns")
      .update({ leads_enrolled: (campaign.leads_enrolled ?? 0) + eligible.length })
      .eq("id", campaign.id);
  }

  await logEvent({
    event_type: "campaign_launched",
    campaign_id: campaign.id,
    client_id: campaign.client_id,
    user_id: userId,
    payload: {
      kind: "via_lead_list_approval",
      campaign_name: campaign.name,
      enrolled: eligible.length,
      ineligible: targetLeadIds.length - eligible.length,
      approval_id: approval.id,
    },
  });

  // Fast-send trigger: kick the cron route asynchronously so freshly-queued
  // step-1 emails go out within seconds rather than waiting for the next
  // hourly cron tick. Fire-and-forget; the cron route is auth-checked by
  // CRON_SECRET if set, otherwise open in dev. Failures here don't fail the
  // approval flow.
  await triggerSendLoopAsync();

  return {
    ok: true,
    summary: {
      enrolled: eligible.length,
      ineligible: targetLeadIds.length - eligible.length,
      campaign_id: campaign.id,
    },
  };
}

/**
 * Best-effort hit of the send-emails cron route. Used after a lead_list
 * approval is approved so freshly-queued step-1 emails go out within ~5
 * minutes (rather than waiting for the hourly tick). Fire-and-forget.
 */
async function triggerSendLoopAsync(): Promise<void> {
  const url = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";
  const headers: Record<string, string> = {};
  if (process.env.CRON_SECRET) {
    headers.Authorization = `Bearer ${process.env.CRON_SECRET}`;
  }
  void fetch(`${url}/api/cron/send-emails`, { headers })
    .then((res) => {
      if (!res.ok) console.warn("[approvals] send-loop trigger non-OK:", res.status);
    })
    .catch((err) => {
      console.warn("[approvals] send-loop trigger failed:", err);
    });
}

/**
 * Final HOS sign-off on a client-approved playbook (from the onboarding
 * interview). Promotes the pending playbook to approved, demotes any prior
 * approved playbook for the client to draft, and sends a "you're live"
 * email to the client CEO via Resend.
 */
async function applyPlaybookApproval(
  approval: Approval,
  userId: string,
): Promise<ActionResult<{ summary: Record<string, unknown> }>> {
  const supabase = createClient();
  if (!approval.related_playbook_id) {
    return { ok: false, error: "Approval has no playbook reference" };
  }
  const { data: pbRow } = await supabase
    .from("playbooks")
    .select("*")
    .eq("id", approval.related_playbook_id)
    .maybeSingle();
  if (!pbRow) return { ok: false, error: "Playbook not found" };
  const playbook = pbRow as Playbook;
  if (playbook.status !== "pending_approval" && playbook.status !== "draft") {
    return { ok: false, error: `Playbook is ${playbook.status} — cannot promote` };
  }

  // Demote any prior approved playbook for the same client.
  await supabase
    .from("playbooks")
    .update({ status: "draft" })
    .eq("client_id", playbook.client_id)
    .eq("status", "approved")
    .neq("id", playbook.id);

  const approvedAt = new Date().toISOString();
  const { error: pbErr } = await supabase
    .from("playbooks")
    .update({ status: "approved", approved_by: userId, approved_at: approvedAt })
    .eq("id", playbook.id);
  if (pbErr) return { ok: false, error: pbErr.message };

  // Send the CEO the "you're live" confirmation. Best-effort — we don't
  // fail the approval if the email errors out.
  let emailSent = false;
  let emailWarning: string | null = null;
  try {
    const { data: clientRow } = await supabase
      .from("clients")
      .select("name, email, owner_name")
      .eq("id", playbook.client_id)
      .maybeSingle();
    const client = clientRow as
      | { name: string; email: string | null; owner_name: string | null }
      | null;
    if (client?.email) {
      const ownerFirst = (client.owner_name ?? "").split(" ")[0] || "there";
      const sendingCfg = await getClientSendingConfig(supabase, playbook.client_id);
      const result = await resend.emails.send({
        from: sendingCfg.from,
        to: client.email,
        subject: `${client.name}: your sales system is live`,
        text: `Hi ${ownerFirst},

Your playbook just cleared final review — your ${client.name} sales system is now live. From here, the agents will start sourcing leads against your ICP, running the sequences you approved, and surfacing anything that needs your touch in the approval queue.

You'll get a weekly digest. Reply to this email any time something looks off.

Talk soon,
Aylek Sales`,
        replyTo: sendingCfg.reply_to,
      });
      if (result.error) throw new Error(result.error.message);
      emailSent = true;
    } else {
      emailWarning = "No CEO email on file — skipped confirmation send.";
    }
  } catch (err) {
    emailWarning = err instanceof Error ? err.message : String(err);
  }

  return {
    ok: true,
    summary: {
      playbook_id: playbook.id,
      client_id: playbook.client_id,
      version: playbook.version,
      ceo_email_sent: emailSent,
      ceo_email_warning: emailWarning,
    },
  };
}

async function applyStrategyChangeApproval(
  approval: Approval,
  userId: string,
): Promise<ActionResult<{ summary: Record<string, unknown> }>> {
  const supabase = createClient();
  const payload = approval.payload as StrategyChangePayload & { mode?: string; version?: number };
  if (!approval.related_playbook_id && !payload.playbook_id) {
    return { ok: false, error: "Approval has no playbook reference" };
  }
  const playbookId = approval.related_playbook_id ?? payload.playbook_id;

  const { data: pbRow } = await supabase
    .from("playbooks")
    .select("*")
    .eq("id", playbookId)
    .maybeSingle();
  if (!pbRow) return { ok: false, error: "Playbook not found" };
  const playbook = pbRow as Playbook;

  const approvedAt = new Date().toISOString();

  if (payload.mode === "promote_draft" || payload.mode === undefined) {
    if (playbook.status !== "pending_approval" && playbook.status !== "draft") {
      return { ok: false, error: `Playbook is ${playbook.status} — cannot promote` };
    }

    // Demote prior approved playbook for the same client to keep the unique
    // index happy.
    await supabase
      .from("playbooks")
      .update({ status: "draft" })
      .eq("client_id", playbook.client_id)
      .eq("status", "approved")
      .neq("id", playbook.id);

    const { error } = await supabase
      .from("playbooks")
      .update({
        status: "approved",
        approved_by: userId,
        approved_at: approvedAt,
      })
      .eq("id", playbook.id);
    if (error) return { ok: false, error: error.message };

    return {
      ok: true,
      summary: {
        mode: "promote_draft",
        playbook_id: playbook.id,
        client_id: playbook.client_id,
        version: playbook.version,
      },
    };
  }

  // mode === "diff": apply the patch on top of the current playbook + bump version
  if (!Array.isArray(payload.diff) || payload.diff.length === 0) {
    return { ok: false, error: "Diff payload is empty" };
  }

  // Apply diff to a deep clone of the row.
  const next = JSON.parse(JSON.stringify(playbook)) as Playbook & Record<string, unknown>;
  for (const change of payload.diff) {
    setPath(next as unknown as Record<string, unknown>, change.path, change.after);
  }

  // Bump version. Keep status='approved' (since the diff came in against an
  // approved playbook). If it came against a draft, status stays 'draft'.
  const newVersion = playbook.version + 1;
  const update: Partial<Playbook> = {
    icp: next.icp,
    sequences: next.sequences,
    escalation_rules: next.escalation_rules,
    channel_flags: next.channel_flags,
    notes: next.notes,
    version: newVersion,
    approved_by: userId,
    approved_at: approvedAt,
  };
  const { error } = await supabase.from("playbooks").update(update).eq("id", playbook.id);
  if (error) return { ok: false, error: error.message };

  return {
    ok: true,
    summary: {
      mode: "diff",
      playbook_id: playbook.id,
      client_id: playbook.client_id,
      version: newVersion,
      diff_count: payload.diff.length,
    },
  };
}

// ──────────────────────────────────────────────────────────────────────────

function substitute(template: string, lead: { contact_name?: string | null; company_name?: string | null }): string {
  return template
    .replace(/\{\{\s*contact_name\s*\}\}/gi, lead.contact_name?.split(" ")[0] ?? "there")
    .replace(/\{\{\s*company_name\s*\}\}/gi, lead.company_name ?? "your team");
}

/** Set a value at a dotted/bracket path (e.g. "sequences.2.subject"). */
function setPath(obj: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split(/\.|\[(\d+)\]/).filter(Boolean);
  let cur: Record<string, unknown> | unknown[] = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const key = parts[i];
    const isIndex = /^\d+$/.test(key);
    const next = (cur as Record<string, unknown>)[key as string];
    if (next == null || typeof next !== "object") {
      const created: unknown = isIndex ? [] : {};
      (cur as Record<string, unknown>)[key as string] = created;
      cur = created as Record<string, unknown> | unknown[];
    } else {
      cur = next as Record<string, unknown> | unknown[];
    }
  }
  (cur as Record<string, unknown>)[parts[parts.length - 1] as string] = value;
}
