"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { requireUser } from "@/lib/auth";
import { logEvent } from "@/lib/events";
import { actionError, type ActionResult } from "@/lib/actions";
import {
  anthropic,
  ANTHROPIC_KEY_MISSING_MESSAGE,
  ANTHROPIC_MODEL,
  isAnthropicKeyMissing,
  isAnthropicUnavailableError,
  parseJsonResponse,
} from "@/lib/anthropic";
import type {
  ChannelFlags,
  EscalationRule,
  ICP,
  Playbook,
  PlaybookSequenceStep,
  ReplyStrategy,
  SalesProcessStage,
  Strategy,
  TeamMember,
  VoiceTone,
} from "@/lib/supabase/types";
import { DEFAULT_SALES_PROCESS } from "@/lib/playbook-defaults";

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
  sender_index: z.number().int().min(0).max(20).nullable().optional(),
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

const StrategySchema = z.object({
  value_proposition: z.string().max(2000).optional(),
  key_messages: z.array(z.string().max(500)).optional(),
  proof_points: z.array(z.string().max(500)).optional(),
  objection_responses: z
    .array(z.object({ objection: z.string().max(300), response: z.string().max(1500) }))
    .optional(),
});

const VoiceToneSchema = z.object({
  tone_descriptors: z.array(z.string().max(60)).optional(),
  writing_style: z.string().max(2000).optional(),
  avoid: z.array(z.string().max(300)).optional(),
  example_phrases: z.array(z.string().max(500)).optional(),
});

const ReplyKindSchema = z.enum([
  "interested",
  "not_now",
  "wrong_person",
  "unsubscribe",
  "objection",
]);

const ReplyStrategySchema = z.record(
  ReplyKindSchema,
  z.object({
    action: z.string().max(500).optional(),
    template: z.string().max(2000).optional(),
  }),
);

const TeamMemberSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1).max(120),
  title: z.string().max(120),
  email: z.string().email(),
});

const SalesProcessStageSchema = z.object({
  id: z.string().min(1).max(60),
  name: z.string().min(1).max(120),
  description: z.string().max(1000),
  agent: z.string().max(60),
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
        strategy: {},
        voice_tone: {},
        reply_strategy: {},
        team_members: [],
        sales_process: DEFAULT_SALES_PROCESS,
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
  strategy: StrategySchema.optional(),
  voice_tone: VoiceToneSchema.optional(),
  reply_strategy: ReplyStrategySchema.optional(),
  team_members: z.array(TeamMemberSchema).optional(),
  sales_process: z.array(SalesProcessStageSchema).optional(),
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
    if (parsed.data.strategy !== undefined)
      update.strategy = parsed.data.strategy as Strategy;
    if (parsed.data.voice_tone !== undefined)
      update.voice_tone = parsed.data.voice_tone as VoiceTone;
    if (parsed.data.reply_strategy !== undefined)
      update.reply_strategy = parsed.data.reply_strategy as ReplyStrategy;
    if (parsed.data.team_members !== undefined)
      update.team_members = parsed.data.team_members as TeamMember[];
    if (parsed.data.sales_process !== undefined)
      update.sales_process = parsed.data.sales_process as SalesProcessStage[];
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
 * Regenerate the sequence for a draft playbook using its Strategy + Voice/Tone +
 * ICP as context. Anthropic-backed; falls back to a placeholder + warning if
 * the API key is missing or the call fails.
 *
 * Caller responsibility: only call this on a draft. Approved/pending playbooks
 * should be re-drafted via proposePlaybookChange.
 */
export async function regenerateSequenceForPlaybook(
  playbookId: string,
): Promise<ActionResult<{ steps: PlaybookSequenceStep[]; source: "ai" | "placeholder"; warning?: string }>> {
  try {
    await requireUser();
    const supabase = createClient();
    const { data: pbRow } = await supabase
      .from("playbooks")
      .select("*, clients(name)")
      .eq("id", playbookId)
      .maybeSingle();
    if (!pbRow) return { ok: false, error: "Playbook not found" };
    const pb = pbRow as Playbook & { clients: { name: string } | null };
    if (pb.status !== "draft") {
      return { ok: false, error: "Sequence can only be regenerated on a draft." };
    }

    const clientName = pb.clients?.name ?? "Client";
    const targetTitle = pb.icp?.target_titles?.[0] ?? "Head of Operations";
    const targetIndustry = pb.icp?.industries?.[0] ?? "B2B services";
    const senderCount = (pb.team_members?.length ?? 0) || 1;

    function placeholder(): PlaybookSequenceStep[] {
      return [
        {
          step: 1,
          delay_days: 0,
          subject: `Quick question about {{company_name}}`,
          body: `Hi {{contact_name}},\n\nReaching out from ${clientName}. ${pb.strategy?.value_proposition || "<add your value proposition>"}\n\nWorth a quick chat?`,
          sender_index: 0,
        },
        {
          step: 2,
          delay_days: 4,
          subject: `Following up`,
          body: `Hi {{contact_name}},\n\nFollowing up on my note. ${(pb.strategy?.key_messages?.[0]) || "<insert a key message>"}\n\n15 minutes this week or next?`,
          sender_index: senderCount > 1 ? 1 : 0,
        },
        {
          step: 3,
          delay_days: 9,
          subject: `Last note from me`,
          body: `Hi {{contact_name}},\n\nLast one. If timing isn't right, no problem. If someone else at {{company_name}} would be better, I'd appreciate a redirect.`,
          sender_index: 0,
        },
      ];
    }

    if (isAnthropicKeyMissing()) {
      return {
        ok: true,
        steps: placeholder(),
        source: "placeholder",
        warning: ANTHROPIC_KEY_MISSING_MESSAGE,
      };
    }

    const system =
      "You are an expert B2B cold email copywriter. Stick exactly to the supplied Voice & Tone, Strategy, and Key Messages. Max 4 sentences per body, one CTA per email, no price talk in cold outreach. Use {{contact_name}} and {{company_name}} for personalisation. Steps 2 and 3 reference prior outreach.";

    const prompt = `Regenerate a 3-step cold email sequence for ${clientName}.

Target: ${targetTitle} at ${targetIndustry} businesses.

STRATEGY
${JSON.stringify(pb.strategy ?? {}, null, 2)}

VOICE & TONE
${JSON.stringify(pb.voice_tone ?? {}, null, 2)}

ICP
${JSON.stringify(pb.icp ?? {}, null, 2)}

Available senders (use the index — 0-based — into team_members for sender_index): ${
      JSON.stringify((pb.team_members ?? []).map((m, i) => ({ i, name: m.name, title: m.title })))
    }

Delays: Step 1 = 0d, Step 2 = 4d, Step 3 = 9d. Default sender_index to 0 unless a different sender is clearly better (e.g. step 3 from a senior name).

Return ONLY valid JSON, no markdown:
[{"step":1,"delay_days":0,"subject":"...","body":"...","sender_index":0},{"step":2,"delay_days":4,"subject":"...","body":"...","sender_index":0},{"step":3,"delay_days":9,"subject":"...","body":"...","sender_index":0}]`;

    try {
      const response = await anthropic.messages.create({
        model: ANTHROPIC_MODEL,
        max_tokens: 1500,
        system,
        messages: [{ role: "user", content: prompt }],
      });
      const text = response.content[0]?.type === "text" ? response.content[0].text : "";
      const parsed = z.array(StepSchema).safeParse(parseJsonResponse(text));
      if (!parsed.success) {
        return {
          ok: true,
          steps: placeholder(),
          source: "placeholder",
          warning: "AI returned an invalid shape — placeholder loaded.",
        };
      }
      return { ok: true, steps: parsed.data as PlaybookSequenceStep[], source: "ai" };
    } catch (apiErr) {
      if (isAnthropicUnavailableError(apiErr)) {
        return {
          ok: true,
          steps: placeholder(),
          source: "placeholder",
          warning: ANTHROPIC_KEY_MISSING_MESSAGE,
        };
      }
      throw apiErr;
    }
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
