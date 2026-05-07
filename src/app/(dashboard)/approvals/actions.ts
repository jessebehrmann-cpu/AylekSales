"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { requireUser } from "@/lib/auth";
import { logEvent } from "@/lib/events";
import { actionError, type ActionResult } from "@/lib/actions";
import type {
  Approval,
  LeadListPayload,
  Playbook,
  PlaybookSequenceStep,
  StrategyChangePayload,
} from "@/lib/supabase/types";

const ApproveSchema = z.object({ id: z.string().uuid() });
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
      const r = await applyLeadListApproval(approval, user.auth.id);
      if (!r.ok) return r;
      summaryForLog = { kind: "lead_list_approved", ...r.summary };
    } else if (approval.type === "strategy_change") {
      const r = await applyStrategyChangeApproval(approval, user.auth.id);
      if (!r.ok) return r;
      summaryForLog = { kind: "strategy_change_approved", ...r.summary };
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
// Internal: apply each type
// ──────────────────────────────────────────────────────────────────────────

async function applyLeadListApproval(
  approval: Approval,
  userId: string,
): Promise<ActionResult<{ summary: Record<string, unknown> }>> {
  const supabase = createClient();
  const payload = approval.payload as LeadListPayload;
  if (!payload?.lead_ids?.length) {
    return { ok: false, error: "Approval has no lead_ids in payload" };
  }
  if (!payload.campaign_id) {
    return {
      ok: false,
      error: "Approval has no campaign_id — attach one before approving",
    };
  }

  // Fetch the campaign + the leads
  const { data: campaignRow } = await supabase
    .from("campaigns")
    .select("*")
    .eq("id", payload.campaign_id)
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
    .in("id", payload.lead_ids);
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
      ineligible: payload.lead_ids.length - eligible.length,
      approval_id: approval.id,
    },
  });

  return {
    ok: true,
    summary: {
      enrolled: eligible.length,
      ineligible: payload.lead_ids.length - eligible.length,
      campaign_id: campaign.id,
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
