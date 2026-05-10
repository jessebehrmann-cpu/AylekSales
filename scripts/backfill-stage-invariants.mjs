/**
 * Backfill the invariants enforced by the stage engine across every existing
 * lead in the database. Idempotent — safe to run on a populated prod DB,
 * safe to re-run.
 *
 * For every lead:
 *  - If lead.process_stage_id resolves to a human-owned stage on the
 *    client's approved playbook → ensure exactly one open
 *    `human_stage_task` approval exists for (client, lead, stage). Create
 *    one if missing.
 *  - If lead.process_stage_id == 'send_proposal' → ensure exactly one open
 *    `proposal_review` approval exists with payload.lead_id set. Create a
 *    placeholder one if missing.
 *  - For every legacy `proposal_review` approval whose payload is missing
 *    `lead_id`, recover the lead via the meeting_note → leads chain and
 *    patch the payload so the new lead-status helper can find it.
 *
 * Run from the repo root:
 *   node scripts/backfill-stage-invariants.mjs
 */

import { readFileSync } from "node:fs";

const env = Object.fromEntries(
  readFileSync(".env.local", "utf8")
    .split("\n")
    .filter((l) => l.includes("=") && !l.startsWith("#"))
    .map((l) => {
      const i = l.indexOf("=");
      return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
    }),
);

const URL = env.NEXT_PUBLIC_SUPABASE_URL;
const SR = env.SUPABASE_SERVICE_ROLE_KEY;
const ANTHROPIC_KEY = env.ANTHROPIC_API_KEY;
const ANTHROPIC_MODEL = env.ANTHROPIC_MODEL ?? "claude-sonnet-4-6";
if (!URL || !SR) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}
const H = {
  apikey: SR,
  Authorization: `Bearer ${SR}`,
  "Content-Type": "application/json",
  Prefer: "return=representation",
};

async function rest(path, init = {}) {
  const res = await fetch(`${URL}/rest/v1/${path}`, {
    ...init,
    headers: { ...H, ...(init.headers ?? {}) },
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`${res.status} ${res.statusText} on ${path}: ${text.slice(0, 300)}`);
  }
  return text ? JSON.parse(text) : null;
}

const SEND_PROPOSAL_STAGE_ID = "send_proposal";

/**
 * Direct Anthropic call (no SDK — keep this script dep-free). Returns
 * {subject, body, warning?}. Falls back to a playbook-shaped draft when
 * the API key is missing or the call fails so the row is always real,
 * editable text rather than a placeholder.
 */
async function draftProposal(playbook, lead) {
  const firstName = (lead.contact_name ?? "").split(" ")[0] || "there";
  const fallback = (warning) => {
    const strategy = playbook?.strategy ?? {};
    const team = playbook?.team_members ?? [];
    const sender = team[0]?.name ?? "the team";
    const valueProp =
      strategy.value_proposition ??
      `We help teams like ${lead.company_name} move faster on what matters most.`;
    const keyMessages = (strategy.key_messages ?? []).slice(0, 2);
    const lines = [
      `Hi ${firstName},`,
      "",
      valueProp,
    ];
    if (keyMessages.length > 0) {
      lines.push("");
      lines.push("A few specifics that map to teams in your space:");
      for (const m of keyMessages) lines.push(`- ${m}`);
    }
    lines.push("");
    lines.push(
      `Would a 20-minute call next week be useful to walk through what this could look like for ${lead.company_name}?`,
    );
    lines.push("");
    lines.push(`Thanks,`);
    lines.push(sender);
    return {
      subject: `${lead.company_name}: a quick proposal`,
      body: lines.join("\n"),
      warning,
    };
  };

  if (!ANTHROPIC_KEY || !ANTHROPIC_KEY.startsWith("sk-ant-")) {
    return fallback("Add your Anthropic API key to enable AI generation.");
  }

  const strategy = playbook?.strategy ?? {};
  const voice = playbook?.voice_tone ?? {};
  const team = playbook?.team_members ?? [];
  const senderName = team[0]?.name ?? "the team";

  const system = `You write outbound B2B proposal emails on behalf of a client team. Anchor every line on the supplied STRATEGY and VOICE & TONE. Reference the lead's company by name. Open with the contact's first name. Body is 4-7 short sentences max with one concrete value proposition and one explicit next-step CTA (typically a 20-30 minute call). No price talk. No marketing fluff. Sign off with the team's voice.`;
  const prompt = `Draft a proposal email to ${lead.company_name}.

LEAD
- Contact: ${lead.contact_name ?? "(unknown)"}
- Title: ${lead.title ?? "(unknown)"}
- Company: ${lead.company_name}
- Industry: ${lead.industry ?? "(unknown)"}

CONTEXT
This lead reached the Send Proposal stage without prior meeting notes. Treat
this as a first-touch proposal anchored on the playbook strategy + voice &
tone, not a follow-up to a specific conversation. Do not invent meeting
context.

STRATEGY (value prop, key messages, proof points)
${JSON.stringify(strategy, null, 2)}

VOICE & TONE
${JSON.stringify(voice, null, 2)}

TEAM (use first member as the sender unless voice says otherwise)
${JSON.stringify(team.slice(0, 3), null, 2)}

Return ONLY valid JSON with this shape, no markdown, no commentary:
{"subject": "...", "body": "..."}

Subject must be under 70 characters and reference ${lead.company_name} or
the value proposition. Body opens with "${firstName}" (case per voice
preference), runs 4-7 sentences, ends with the next-step CTA, and signs off
with ${senderName}'s name.`;

  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": ANTHROPIC_KEY,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: ANTHROPIC_MODEL,
        max_tokens: 1500,
        system,
        messages: [{ role: "user", content: prompt }],
      }),
    });
    if (!res.ok) {
      return fallback(`Claude API ${res.status}: ${(await res.text()).slice(0, 200)}`);
    }
    const json = await res.json();
    const text = json?.content?.[0]?.type === "text" ? json.content[0].text : "";
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    const raw = (fenced ? fenced[1] : text).trim();
    const parsed = JSON.parse(raw);
    if (!parsed.subject || !parsed.body) {
      return fallback("AI returned an invalid shape — playbook fallback used.");
    }
    return { subject: String(parsed.subject).slice(0, 200), body: String(parsed.body) };
  } catch (err) {
    return fallback(err instanceof Error ? err.message : String(err));
  }
}

// ─── 1. Load every lead with a process_stage_id + their playbook stages ──
console.log("[1/3] Loading leads + approved playbooks");
const leads = await rest(
  `leads?select=id,client_id,process_stage_id,company_name,contact_name,title,industry&process_stage_id=not.is.null`,
);
console.log(`    ${leads.length} leads on a process stage`);

const distinctClients = [...new Set(leads.map((l) => l.client_id).filter(Boolean))];
const playbooksByClient = new Map();
if (distinctClients.length > 0) {
  const list = distinctClients.map((id) => `"${id}"`).join(",");
  const pbs = await rest(
    `playbooks?client_id=in.(${list})&status=eq.approved&select=*`,
  );
  for (const pb of pbs) {
    playbooksByClient.set(pb.client_id, { id: pb.id, stages: pb.sales_process ?? [], full: pb });
  }
}
console.log(`    ${playbooksByClient.size} approved playbooks loaded`);

// Patch legacy proposal_review approvals missing payload.lead_id BEFORE we
// build the in-memory dedup map. Otherwise legacy rows look unowned and the
// invariant pass would create a duplicate.
console.log("\n[2/3] Patching legacy proposal_review payloads");
const allProposalReviews = await rest(
  `approvals?type=eq.proposal_review&select=id,payload`,
);
const needPatch = allProposalReviews.filter(
  (a) => a.payload && !a.payload.lead_id && a.payload.meeting_note_id,
);
let patched = 0;
for (const appr of needPatch) {
  const note = (
    await rest(
      `meeting_notes?id=eq.${appr.payload.meeting_note_id}&select=lead_id&limit=1`,
    )
  )[0];
  if (!note) continue;
  await rest(`approvals?id=eq.${appr.id}`, {
    method: "PATCH",
    body: JSON.stringify({
      payload: {
        ...appr.payload,
        lead_id: note.lead_id,
        source: appr.payload.source ?? "post_meeting",
      },
    }),
  });
  patched++;
}
console.log(`    patched ${patched} legacy approvals`);

// Pre-fetch every open human_stage_task + proposal_review so we can dedup
// in-memory rather than per-lead round-tripping.
const openHumanTasks = await rest(
  `approvals?type=eq.human_stage_task&status=eq.pending&select=id,client_id,payload`,
);
const openProposalReviews = await rest(
  `approvals?type=eq.proposal_review&status=eq.pending&select=id,client_id,payload`,
);

const humanTaskKey = (clientId, leadId, stageId) => `${clientId}::${leadId}::${stageId}`;
const humanTaskSeen = new Set(
  openHumanTasks
    .filter((a) => a.payload?.lead_id && a.payload?.stage_id)
    .map((a) => humanTaskKey(a.client_id, a.payload.lead_id, a.payload.stage_id)),
);
const proposalReviewByLead = new Map(
  openProposalReviews
    .filter((a) => a.payload?.lead_id)
    .map((a) => [a.payload.lead_id, a]),
);

// ─── 3. Walk leads, ensure invariants ────────────────────────────────────
console.log("\n[3/3] Ensuring invariants");
let createdHuman = 0;
let createdProposal = 0;
let skippedNoClient = 0;
let skippedNoPlaybook = 0;
let skippedStageNotInPlaybook = 0;

for (const lead of leads) {
  if (!lead.client_id) {
    skippedNoClient++;
    continue;
  }
  const pb = playbooksByClient.get(lead.client_id);
  if (!pb) {
    skippedNoPlaybook++;
    continue;
  }
  const stage = pb.stages.find((s) => s.id === lead.process_stage_id);
  if (!stage) {
    skippedStageNotInPlaybook++;
    continue;
  }

  const isHuman = (stage.agent ?? "").trim().toLowerCase() === "human";
  if (isHuman) {
    const k = humanTaskKey(lead.client_id, lead.id, stage.id);
    if (!humanTaskSeen.has(k)) {
      await rest(`approvals`, {
        method: "POST",
        body: JSON.stringify({
          client_id: lead.client_id,
          type: "human_stage_task",
          status: "pending",
          title: `${lead.company_name}: ${stage.name}`,
          summary: `Lead reached a human-owned stage. Automation paused — HOS to mark the stage complete.`,
          payload: {
            stage_id: stage.id,
            stage_name: stage.name,
            agent: stage.agent,
            lead_id: lead.id,
            message: `Lead reached "${stage.name}" — automation paused, awaiting human action.`,
          },
        }),
      });
      humanTaskSeen.add(k);
      createdHuman++;
    }
  }

  if (stage.id === SEND_PROPOSAL_STAGE_ID) {
    if (!proposalReviewByLead.has(lead.id)) {
      console.log(`    drafting proposal for ${lead.company_name}…`);
      const draft = await draftProposal(pb.full, lead);
      const created = await rest(`approvals`, {
        method: "POST",
        body: JSON.stringify({
          client_id: lead.client_id,
          type: "proposal_review",
          status: "pending",
          title: `${lead.company_name}: review proposal draft`,
          summary: `Lead reached Send Proposal — Claude drafted a proposal from the playbook. Review + send.`,
          payload: {
            lead_id: lead.id,
            meeting_note_id: null,
            drafted_subject: draft.subject,
            drafted_body: draft.body,
            outcome: null,
            source: "auto_on_send_proposal",
            ai_warning: draft.warning ?? null,
          },
          related_playbook_id: pb.id,
        }),
      });
      proposalReviewByLead.set(lead.id, created?.[0] ?? created);
      createdProposal++;
    }
  }
}

console.log(`    created ${createdHuman} human_stage_task approvals`);
console.log(`    created ${createdProposal} proposal_review approvals`);
console.log(`    skipped (no client): ${skippedNoClient}`);
console.log(`    skipped (no approved playbook): ${skippedNoPlaybook}`);
console.log(`    skipped (stage not in playbook): ${skippedStageNotInPlaybook}`);

console.log(`\n✓ Backfill complete.`);
