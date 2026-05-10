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

// ─── 1. Load every lead with a process_stage_id + their playbook stages ──
console.log("[1/3] Loading leads + approved playbooks");
const leads = await rest(
  `leads?select=id,client_id,process_stage_id,company_name,contact_name&process_stage_id=not.is.null`,
);
console.log(`    ${leads.length} leads on a process stage`);

const distinctClients = [...new Set(leads.map((l) => l.client_id).filter(Boolean))];
const playbooksByClient = new Map();
if (distinctClients.length > 0) {
  const list = distinctClients.map((id) => `"${id}"`).join(",");
  const pbs = await rest(
    `playbooks?client_id=in.(${list})&status=eq.approved&select=id,client_id,sales_process`,
  );
  for (const pb of pbs) {
    playbooksByClient.set(pb.client_id, { id: pb.id, stages: pb.sales_process ?? [] });
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
      const firstName = (lead.contact_name ?? "").split(" ")[0] || "there";
      const body = `Hi ${firstName},\n\n[Draft your proposal here. Lead reached the Send Proposal stage but no meeting-notes context was supplied — write the proposal manually before sending.]\n\nThanks,\nAylek Sales`;
      const created = await rest(`approvals`, {
        method: "POST",
        body: JSON.stringify({
          client_id: lead.client_id,
          type: "proposal_review",
          status: "pending",
          title: `${lead.company_name}: review proposal draft`,
          summary: `Lead reached Send Proposal — draft a proposal and send.`,
          payload: {
            lead_id: lead.id,
            meeting_note_id: null,
            drafted_subject: `Proposal for ${lead.company_name}`,
            drafted_body: body,
            outcome: null,
            source: "auto_on_send_proposal",
            ai_warning: null,
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
