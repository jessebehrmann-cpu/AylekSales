"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { requireUser } from "@/lib/auth";
import { logEvent } from "@/lib/events";
import { actionError, type ActionResult } from "@/lib/actions";
import type {
  ChannelFlags,
  EscalationRule,
  ICP,
  Playbook,
  PlaybookSequenceStep,
} from "@/lib/supabase/types";

const ICPSchema = z.object({
  industries: z.array(z.string()).optional(),
  company_size: z.string().optional(),
  target_titles: z.array(z.string()).optional(),
  geography: z.array(z.string()).optional(),
  qualification_signal: z.string().optional(),
  disqualifiers: z.array(z.string()).optional(),
});

const StepSchema = z.object({
  step: z.number().int().min(1).max(10),
  subject: z.string().min(1).max(200),
  body: z.string().min(1).max(8000),
  delay_days: z.number().int().min(0).max(60),
  branching_rules: z
    .object({
      on_open: z.object({ wait_days: z.number().int().min(0).max(60).optional() }).optional(),
      on_no_reply: z.object({ wait_days: z.number().int().min(0).max(60).optional() }).optional(),
    })
    .optional(),
});

const EscalationSchema = z.object({
  after_step: z.number().int().min(1).max(10),
  action: z.enum(["pause", "notify", "handoff"]),
  notify_email: z.string().email().optional(),
});

const ChannelFlagsSchema = z.object({
  email: z.boolean(),
  phone: z.boolean(),
  linkedin: z.boolean(),
});

/**
 * Create an empty draft playbook for a client. Idempotent — if a draft already
 * exists, returns it instead of creating another.
 */
export async function ensureDraftPlaybook(clientId: string): Promise<ActionResult<{ id: string }>> {
  try {
    const user = await requireUser();
    const supabase = createClient();

    const { data: existing } = await supabase
      .from("playbooks")
      .select("id")
      .eq("client_id", clientId)
      .eq("status", "draft")
      .maybeSingle();

    if (existing) return { ok: true, id: existing.id };

    // Determine starting version from the highest existing for this client.
    const { data: latest } = await supabase
      .from("playbooks")
      .select("version")
      .eq("client_id", clientId)
      .order("version", { ascending: false })
      .limit(1)
      .maybeSingle();
    const nextVersion = (latest?.version ?? 0) + 1;

    const { data: row, error } = await supabase
      .from("playbooks")
      .insert({
        client_id: clientId,
        version: nextVersion,
        status: "draft",
        icp: {},
        sequences: [],
        escalation_rules: [],
        channel_flags: { email: true, phone: false, linkedin: false },
        created_by: user.auth.id,
      })
      .select("id")
      .single();
    if (error || !row) return { ok: false, error: error?.message ?? "Insert failed" };

    revalidatePath("/playbooks");
    return { ok: true, id: row.id };
  } catch (err) {
    return actionError(err);
  }
}

const SaveDraftSchema = z.object({
  id: z.string().uuid(),
  icp: ICPSchema.optional(),
  sequences: z.array(StepSchema).optional(),
  escalation_rules: z.array(EscalationSchema).optional(),
  channel_flags: ChannelFlagsSchema.optional(),
  notes: z.string().max(4000).optional().nullable(),
});

/**
 * Save edits to a draft playbook. Refuses edits to approved playbooks (those
 * must go through the strategy_change approval flow instead).
 */
export async function saveDraftPlaybook(input: unknown): Promise<ActionResult> {
  try {
    await requireUser();
    const parsed = SaveDraftSchema.safeParse(input);
    if (!parsed.success) {
      return { ok: false, error: parsed.error.issues.map((i) => i.message).join("; ") };
    }
    const supabase = createClient();
    const { data: pb } = await supabase
      .from("playbooks")
      .select("status")
      .eq("id", parsed.data.id)
      .maybeSingle();
    if (!pb) return { ok: false, error: "Playbook not found" };
    if (pb.status === "approved") {
      return {
        ok: false,
        error: "Approved playbooks can't be edited directly — submit a strategy change instead.",
      };
    }

    const update: Partial<Playbook> = {};
    if (parsed.data.icp !== undefined) update.icp = parsed.data.icp as ICP;
    if (parsed.data.sequences !== undefined)
      update.sequences = parsed.data.sequences as PlaybookSequenceStep[];
    if (parsed.data.escalation_rules !== undefined)
      update.escalation_rules = parsed.data.escalation_rules as EscalationRule[];
    if (parsed.data.channel_flags !== undefined)
      update.channel_flags = parsed.data.channel_flags as ChannelFlags;
    if (parsed.data.notes !== undefined) update.notes = parsed.data.notes;

    const { error } = await supabase.from("playbooks").update(update).eq("id", parsed.data.id);
    if (error) return { ok: false, error: error.message };

    revalidatePath("/playbooks");
    revalidatePath(`/playbooks/${parsed.data.id}`);
    return { ok: true };
  } catch (err) {
    return actionError(err);
  }
}

/**
 * Submit a draft playbook for HOS approval. Creates an `approvals` row
 * (type='strategy_change') referencing this playbook. The HOS approves it from
 * /approvals — which flips the playbook to 'approved' and demotes any prior
 * approved playbook to keep the unique-approved-per-client invariant.
 */
export async function submitPlaybookForApproval(
  playbookId: string,
): Promise<ActionResult<{ approval_id: string }>> {
  try {
    const user = await requireUser();
    const supabase = createClient();

    const { data: pb } = await supabase
      .from("playbooks")
      .select("*, clients(name)")
      .eq("id", playbookId)
      .maybeSingle();
    if (!pb) return { ok: false, error: "Playbook not found" };

    const playbook = pb as Playbook & { clients: { name: string } | null };
    if (playbook.status !== "draft") {
      return { ok: false, error: "Only draft playbooks can be submitted." };
    }
    if ((playbook.sequences?.length ?? 0) === 0) {
      return { ok: false, error: "Add at least one sequence step before submitting." };
    }

    const submittedAt = new Date().toISOString();
    const { error: pbErr } = await supabase
      .from("playbooks")
      .update({ status: "pending_approval", submitted_at: submittedAt })
      .eq("id", playbookId);
    if (pbErr) return { ok: false, error: pbErr.message };

    const { data: approval, error: apprErr } = await supabase
      .from("approvals")
      .insert({
        client_id: playbook.client_id,
        type: "strategy_change",
        status: "pending",
        title: `Playbook v${playbook.version} submitted`,
        summary: `${playbook.clients?.name ?? ""}: ${playbook.sequences.length}-step sequence, ICP across ${playbook.icp?.industries?.length ?? 0} industries.`,
        payload: {
          playbook_id: playbookId,
          mode: "promote_draft",
          version: playbook.version,
          source: "hos",
        },
        related_playbook_id: playbookId,
        created_by: user.auth.id,
      })
      .select("id")
      .single();
    if (apprErr || !approval) return { ok: false, error: apprErr?.message ?? "Approval create failed" };

    await logEvent({
      event_type: "ai_action",
      client_id: playbook.client_id,
      user_id: user.auth.id,
      payload: {
        kind: "playbook_submitted",
        playbook_id: playbookId,
        version: playbook.version,
        client_name: playbook.clients?.name,
      },
    });

    revalidatePath("/playbooks");
    revalidatePath(`/playbooks/${playbookId}`);
    revalidatePath("/approvals");
    revalidatePath("/dashboard");
    return { ok: true, approval_id: approval.id };
  } catch (err) {
    return actionError(err);
  }
}

/**
 * Convenience for the Learning Agent (or human ops) to propose changes to the
 * current approved playbook. Produces a strategy_change approval with a diff
 * payload — applied on approval.
 */
export async function proposePlaybookChange(input: {
  playbook_id: string;
  diff: Array<{ path: string; before: unknown; after: unknown }>;
  reasoning?: string;
  source?: string;
}): Promise<ActionResult<{ approval_id: string }>> {
  try {
    const user = await requireUser();
    const supabase = createClient();

    const { data: pb } = await supabase
      .from("playbooks")
      .select("*, clients(name)")
      .eq("id", input.playbook_id)
      .maybeSingle();
    if (!pb) return { ok: false, error: "Playbook not found" };
    const playbook = pb as Playbook & { clients: { name: string } | null };

    const { data: approval, error } = await supabase
      .from("approvals")
      .insert({
        client_id: playbook.client_id,
        type: "strategy_change",
        status: "pending",
        title: `Strategy change proposed`,
        summary: input.reasoning?.slice(0, 280) ?? null,
        payload: {
          playbook_id: input.playbook_id,
          mode: "diff",
          diff: input.diff,
          reasoning: input.reasoning,
          source: input.source ?? "hos",
        },
        related_playbook_id: input.playbook_id,
        created_by: user.auth.id,
      })
      .select("id")
      .single();
    if (error || !approval) return { ok: false, error: error?.message ?? "Insert failed" };

    revalidatePath("/approvals");
    revalidatePath("/dashboard");
    return { ok: true, approval_id: approval.id };
  } catch (err) {
    return actionError(err);
  }
}
