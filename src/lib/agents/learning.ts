/**
 * Learning Agent — analyses per-step performance for a client and, when a
 * step is performing more than 20% below benchmark on opens or replies,
 * creates a strategy_change approval with a Claude-generated improved
 * subject line and the supporting data.
 *
 * Trigger: typically called after every 50 emails sent for a client. The
 * route at /api/agents/learning exposes it for cron + manual triggers.
 *
 * Anthropic-backed; degrades gracefully when ANTHROPIC_API_KEY is missing
 * or the model errors — in that case we still create the approval but with
 * a placeholder "improved subject" the operator can edit.
 */

import { createServiceClient } from "@/lib/supabase/server";
import {
  anthropic,
  ANTHROPIC_KEY_MISSING_MESSAGE,
  ANTHROPIC_MODEL,
  isAnthropicKeyMissing,
  isAnthropicUnavailableError,
} from "@/lib/anthropic";
import { logEvent } from "@/lib/events";
import type { Playbook, PlaybookSequenceStep } from "@/lib/supabase/types";

/**
 * Industry-rough benchmarks. The Learning Agent flags a step when its rate
 * is < (1 - threshold) * benchmark. Thresholds tunable per client later.
 */
const BENCHMARK_OPEN_RATE = 0.4; // 40% open is a reasonable cold-email norm
const BENCHMARK_REPLY_RATE = 0.05; // 5% reply
const UNDERPERFORM_THRESHOLD = 0.2; // 20% below benchmark
const MIN_SAMPLE_SENT = 20; // need at least this many sends per step before we judge

export type StepStats = {
  step: number;
  sent: number;
  opened: number;
  replied: number;
  open_rate: number;
  reply_rate: number;
};

export type LearningRunResult =
  | {
      ok: true;
      client_id: string;
      total_sent: number;
      step_stats: StepStats[];
      proposals_created: number;
      approval_ids: string[];
    }
  | { ok: false; error: string };

export async function runLearningAnalysis(
  clientId: string,
  opts: { triggeredBy?: string } = {},
): Promise<LearningRunResult> {
  const supabase = createServiceClient();

  // 1. Pull all outbound emails for this client. Keep the query simple —
  // group by step_number client-side.
  const { data: emails, error } = await supabase
    .from("emails")
    .select("id, step_number, status, sent_at, opened_at, replied_at, subject")
    .eq("client_id", clientId)
    .eq("direction", "outbound")
    .not("sent_at", "is", null);
  if (error) return { ok: false, error: error.message };

  type EmailRow = {
    id: string;
    step_number: number | null;
    status: string;
    sent_at: string | null;
    opened_at: string | null;
    replied_at: string | null;
    subject: string | null;
  };
  const allEmails = (emails ?? []) as EmailRow[];
  const total = allEmails.length;

  // Aggregate per step_number
  const grouped = new Map<number, EmailRow[]>();
  for (const e of allEmails) {
    if (e.step_number == null) continue;
    if (!grouped.has(e.step_number)) grouped.set(e.step_number, []);
    grouped.get(e.step_number)!.push(e);
  }

  const stepStats: StepStats[] = Array.from(grouped.entries())
    .sort(([a], [b]) => a - b)
    .map(([step, list]) => {
      const sent = list.length;
      const opened = list.filter((e) => e.opened_at != null).length;
      const replied = list.filter((e) => e.replied_at != null).length;
      return {
        step,
        sent,
        opened,
        replied,
        open_rate: sent > 0 ? opened / sent : 0,
        reply_rate: sent > 0 ? replied / sent : 0,
      };
    });

  // 2. Find the client's approved playbook so we can read the current
  // sequence and propose against it
  const { data: pbRow } = await supabase
    .from("playbooks")
    .select("*")
    .eq("client_id", clientId)
    .eq("status", "approved")
    .maybeSingle();
  if (!pbRow) {
    // No live playbook — nothing to propose against. Still log the run.
    await logEvent({
      service: true,
      event_type: "ai_action",
      client_id: clientId,
      payload: { kind: "learning_run", total_sent: total, step_stats: stepStats, note: "no approved playbook" },
    });
    return {
      ok: true,
      client_id: clientId,
      total_sent: total,
      step_stats: stepStats,
      proposals_created: 0,
      approval_ids: [],
    };
  }
  const playbook = pbRow as Playbook;
  const stagesById = new Map<number, PlaybookSequenceStep>(
    (playbook.sequences ?? []).map((s) => [s.step, s]),
  );

  // 3. For each underperforming step with enough volume, create a proposal
  const approvalIds: string[] = [];
  for (const stat of stepStats) {
    if (stat.sent < MIN_SAMPLE_SENT) continue;

    const openLow = stat.open_rate < BENCHMARK_OPEN_RATE * (1 - UNDERPERFORM_THRESHOLD);
    const replyLow = stat.reply_rate < BENCHMARK_REPLY_RATE * (1 - UNDERPERFORM_THRESHOLD);
    if (!openLow && !replyLow) continue;

    const step = stagesById.get(stat.step);
    if (!step) continue; // step removed from sequence — skip

    const sampleSubjects = Array.from(
      new Set(
        grouped
          .get(stat.step)!
          .map((e) => e.subject)
          .filter((s): s is string => !!s),
      ),
    ).slice(0, 5);

    const improved = await proposeImprovedSubject({
      currentSubject: step.subject,
      currentBody: step.body,
      stepNumber: stat.step,
      stat,
      reason: openLow ? "low open rate" : "low reply rate",
      sampleSubjects,
    });

    const reasoning = `Step ${stat.step} is below benchmark on ${openLow ? "open" : "reply"} rate. Sent ${stat.sent}, opened ${stat.opened} (${(stat.open_rate * 100).toFixed(1)}%), replied ${stat.replied} (${(stat.reply_rate * 100).toFixed(1)}%). Benchmark: ${(BENCHMARK_OPEN_RATE * 100).toFixed(0)}% open / ${(BENCHMARK_REPLY_RATE * 100).toFixed(1)}% reply.`;

    const stepIdx = (playbook.sequences ?? []).findIndex((s) => s.step === stat.step);
    if (stepIdx === -1) continue;

    const { data: appr, error: apprErr } = await supabase
      .from("approvals")
      .insert({
        client_id: clientId,
        type: "strategy_change",
        status: "pending",
        title: `Subject line proposal for step ${stat.step}`,
        summary: reasoning.slice(0, 280),
        payload: {
          playbook_id: playbook.id,
          mode: "diff",
          diff: [
            {
              path: `sequences.${stepIdx}.subject`,
              before: step.subject,
              after: improved.subject,
            },
          ],
          reasoning,
          source: "learning-agent",
          stat,
          ai_warning: improved.warning ?? null,
        },
        related_playbook_id: playbook.id,
      })
      .select("id")
      .single();
    if (apprErr || !appr) {
      console.error("[learning] approval create failed", apprErr);
      continue;
    }
    approvalIds.push(appr.id);
  }

  await logEvent({
    service: true,
    event_type: "ai_action",
    client_id: clientId,
    user_id: opts.triggeredBy ?? null,
    payload: {
      kind: "learning_run",
      total_sent: total,
      step_stats: stepStats,
      proposals_created: approvalIds.length,
    },
  });

  return {
    ok: true,
    client_id: clientId,
    total_sent: total,
    step_stats: stepStats,
    proposals_created: approvalIds.length,
    approval_ids: approvalIds,
  };
}

async function proposeImprovedSubject(input: {
  currentSubject: string;
  currentBody: string;
  stepNumber: number;
  stat: StepStats;
  reason: string;
  sampleSubjects: string[];
}): Promise<{ subject: string; warning?: string }> {
  if (isAnthropicKeyMissing()) {
    return {
      subject: `${input.currentSubject} (try a fresh angle)`,
      warning: ANTHROPIC_KEY_MISSING_MESSAGE,
    };
  }

  const prompt = `You optimise B2B cold-email subject lines based on performance data.

Step ${input.stepNumber} is underperforming.
Reason: ${input.reason}.
Current subject: "${input.currentSubject}"
Current body (for context):
${input.currentBody}

Past variations tried (last few):
${input.sampleSubjects.map((s) => `- ${s}`).join("\n") || "(only the current subject)"}

Performance: ${input.stat.sent} sent, ${input.stat.opened} opened (${(input.stat.open_rate * 100).toFixed(1)}%), ${input.stat.replied} replied (${(input.stat.reply_rate * 100).toFixed(1)}%).

Write ONE improved subject line. Constraints:
- Under 60 characters
- No emojis, no exclamation marks
- Specific over generic
- Lowercase opening is fine

Return ONLY the new subject line as a single line of text. No quotes, no commentary.`;

  try {
    const response = await anthropic.messages.create({
      model: ANTHROPIC_MODEL,
      max_tokens: 80,
      messages: [{ role: "user", content: prompt }],
    });
    const text = response.content[0]?.type === "text" ? response.content[0].text.trim() : "";
    if (!text) {
      return {
        subject: `${input.currentSubject} (rewrite)`,
        warning: "AI returned empty — placeholder used.",
      };
    }
    // Strip stray quotes / trailing punctuation
    const cleaned = text.replace(/^["'`]+|["'`]+$/g, "").split("\n")[0].trim();
    return { subject: cleaned.slice(0, 200) };
  } catch (err) {
    if (isAnthropicUnavailableError(err)) {
      return {
        subject: `${input.currentSubject} (try a fresh angle)`,
        warning: ANTHROPIC_KEY_MISSING_MESSAGE,
      };
    }
    return {
      subject: `${input.currentSubject} (rewrite)`,
      warning: err instanceof Error ? err.message : String(err),
    };
  }
}
