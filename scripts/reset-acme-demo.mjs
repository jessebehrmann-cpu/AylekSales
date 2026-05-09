/**
 * Reset Acme into a known demo state:
 *  - 4 agent-sourced leads back to pending_approval, parent lead_list approval pending
 *  - All other Acme leads distributed across at least 5 sales-process stages
 *    so the dashboard funnel has real data to display.
 *
 * Idempotent — re-running just snaps the state back to the same shape.
 *
 * Run from the repo root:
 *   node scripts/reset-acme-demo.mjs
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
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} on ${path}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}

// ─── 1. Locate Acme + the lead_list approval ────────────────────────────
console.log("[1/4] Resolving Acme + lead_list approval");
const acme = (await rest(`clients?name=eq.Acme%20Corp&select=id&limit=1`))[0];
if (!acme) {
  console.error("No Acme client — run scripts/seed-acme.mjs first.");
  process.exit(1);
}
const acmeId = acme.id;

const leadListAppr = (
  await rest(
    `approvals?client_id=eq.${acmeId}&type=eq.lead_list&select=*&order=created_at.desc&limit=1`,
  )
)[0];
if (!leadListAppr) {
  console.error("No lead_list approval for Acme — run scripts/seed-acme.mjs first.");
  process.exit(1);
}
const agentLeadIds = (leadListAppr.payload?.lead_ids ?? []);
console.log(`    approval ${leadListAppr.id} (${leadListAppr.status}) → ${agentLeadIds.length} agent leads`);

// ─── 2. Reset agent leads + approval + cancel any pending emails ────────
console.log("\n[2/4] Resetting agent leads + approval + cancelling pending emails");
if (agentLeadIds.length > 0) {
  await rest(`leads?id=in.(${agentLeadIds.map((i) => `"${i}"`).join(",")})`, {
    method: "PATCH",
    body: JSON.stringify({ approval_status: "pending_approval", process_stage_id: null }),
  });
  console.log(`    ${agentLeadIds.length} agent leads → pending_approval`);

  // Cancel any pending emails queued for them (from prior approve runs)
  const cancelRes = await rest(
    `emails?lead_id=in.(${agentLeadIds.map((i) => `"${i}"`).join(",")})&status=eq.pending`,
    { method: "DELETE" },
  );
  console.log(`    cancelled ${cancelRes?.length ?? 0} pending emails`);
}

await rest(`approvals?id=eq.${leadListAppr.id}`, {
  method: "PATCH",
  body: JSON.stringify({
    status: "pending",
    approved_by: null,
    decided_at: null,
  }),
});
console.log(`    approval → pending`);

// ─── 3. Distribute non-agent Acme leads across the funnel ───────────────
console.log("\n[3/4] Distributing non-agent leads across sales-process stages");

const otherLeads = await rest(
  `leads?client_id=eq.${acmeId}&source=neq.ai_enriched&select=id,company_name&order=company_name.asc`,
);
console.log(`    found ${otherLeads.length} non-agent leads`);

// Pick up the live playbook's sales_process so the stage ids match what the
// funnel expects.
const playbook = (
  await rest(
    `playbooks?client_id=eq.${acmeId}&status=eq.approved&select=sales_process&limit=1`,
  )
)[0];
const stages = playbook?.sales_process ?? [];
if (stages.length < 5) {
  console.error(`    live playbook only has ${stages.length} stages; need at least 5. Aborting distribution.`);
} else {
  // Spread across at least 5 stages; favour real-funnel shape:
  //   prospect (the new ones), outreach, book_meeting, have_meeting, send_proposal, payment
  // Cycle through this preferred sequence so a small lead set still hits 5+ stages.
  const desired = [
    "prospect",
    "outreach",
    "book_meeting",
    "have_meeting", // human stage — proves the gate
    "send_proposal",
    "payment",
    "handover",
  ].filter((id) => stages.some((s) => s.id === id));

  const updates = [];
  for (let i = 0; i < otherLeads.length; i++) {
    const stageId = desired[i % desired.length];
    updates.push({ leadId: otherLeads[i].id, name: otherLeads[i].company_name, stageId });
  }

  for (const u of updates) {
    await rest(`leads?id=eq.${u.leadId}`, {
      method: "PATCH",
      body: JSON.stringify({ process_stage_id: u.stageId }),
    });
    console.log(`    ${u.name.padEnd(28)} → ${u.stageId}`);
  }

  // Confirm distribution: count distinct stages used
  const stagesUsed = new Set(updates.map((u) => u.stageId));
  console.log(`    distributed across ${stagesUsed.size} stage${stagesUsed.size === 1 ? "" : "s"}`);
}

// ─── 4. Confirmation ────────────────────────────────────────────────────
console.log("\n[4/4] Verifying state");
const pendingApprovals = await rest(
  `approvals?status=eq.pending&select=id,type`,
);
const pendingAgentLeads = await rest(
  `leads?source=eq.ai_enriched&approval_status=eq.pending_approval&select=id,company_name`,
);
const stageDist = await rest(
  `leads?client_id=eq.${acmeId}&select=process_stage_id,company_name`,
);
const distMap = new Map();
for (const l of stageDist) {
  const k = l.process_stage_id ?? "(unset)";
  distMap.set(k, (distMap.get(k) ?? 0) + 1);
}

console.log(JSON.stringify({
  pending_approvals: pendingApprovals,
  pending_agent_leads: pendingAgentLeads,
  stage_distribution: Object.fromEntries(distMap),
}, null, 2));

console.log(`\n✓ Reset complete. Visit /dashboard for the funnel and /approvals for the inline approval flow.`);
