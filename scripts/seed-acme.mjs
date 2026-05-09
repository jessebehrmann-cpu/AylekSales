/**
 * Seed Acme Corp + HOS user, then run the full playbook flow as a smoke test.
 *
 *  1. Create Acme Corp client (idempotent)
 *  2. Create HOS auth user + public.users row, role = admin (idempotent)
 *  3. Insert ~5 sample leads for Acme Corp (operator-imported, approval_status='approved')
 *  3b. Insert 4 agent-sourced leads (source='ai_enriched', approval_status='pending_approval')
 *      and create a pending lead_list approval so /approvals isn't empty
 *  4. Create a draft playbook with strategy / voice / reply_strategy / team_members populated
 *  5. Submit it for approval (creates a strategy_change approval row)
 *  6. Approve it (flips playbook → approved)
 *  7. Create + launch a campaign for Acme Corp (DB hard gate enforces approved playbook)
 *  8. Print a summary so the human can verify in the UI
 *
 * Run from the repo root: `node scripts/seed-acme.mjs`
 *
 * Industry-agnostic — Acme Corp here is a generic B2B SaaS client. Edit
 * SAMPLE_LEADS / AGENT_LEADS / playbook payload below to match your test scenario.
 *
 * Uses SUPABASE_SERVICE_ROLE_KEY which bypasses RLS — only ever run this
 * against a development project.
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

const SUPABASE_URL = env.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE_ROLE = env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SERVICE_ROLE) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env.local");
  process.exit(1);
}

const HEADERS = {
  apikey: SERVICE_ROLE,
  Authorization: `Bearer ${SERVICE_ROLE}`,
  "Content-Type": "application/json",
};

async function rest(path, init = {}) {
  const url = `${SUPABASE_URL}/rest/v1/${path}`;
  const res = await fetch(url, {
    ...init,
    headers: { ...HEADERS, Prefer: "return=representation", ...(init.headers ?? {}) },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} on ${path}: ${text.slice(0, 400)}`);
  return text ? JSON.parse(text) : null;
}

async function adminAuth(path, init = {}) {
  const url = `${SUPABASE_URL}/auth/v1/${path}`;
  const res = await fetch(url, {
    ...init,
    headers: { ...HEADERS, ...(init.headers ?? {}) },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${res.status} on auth/${path}: ${text.slice(0, 400)}`);
  return text ? JSON.parse(text) : null;
}

// ─── 1. Acme Corp client ──────────────────────────────────────────────────
console.log("\n[1/8] Acme Corp client");
let acme = (await rest(`clients?name=eq.Acme%20Corp&select=*&limit=1`))[0];
if (acme) {
  console.log("    already exists:", acme.id);
} else {
  acme = (
    await rest(`clients`, {
      method: "POST",
      body: JSON.stringify({
        name: "Acme Corp",
        owner_name: "Sarah Chen",
        email: "ops@acme.example.com",
        phone: "0400 111 222",
        retainer_amount: 2500,
        revenue_share_pct: 8,
        status: "active",
        notes: "Seeded by scripts/seed-acme.mjs for smoke testing. Generic B2B SaaS — edit playbook + leads to match your scenario.",
      }),
    })
  )[0];
  console.log("    created:", acme.id);
}

// ─── 2. HOS user (auth + public.users) ────────────────────────────────────
console.log("\n[2/8] HOS user (hos@aylek.dev / Aylek123!)");
const HOS_EMAIL = "hos@aylek.dev";
const HOS_PASSWORD = "Aylek123!";

const usersList = await adminAuth(`admin/users?email=${encodeURIComponent(HOS_EMAIL)}`);
let hosAuthUser = usersList.users?.[0];
if (hosAuthUser) {
  console.log("    auth user already exists:", hosAuthUser.id);
} else {
  hosAuthUser = await adminAuth(`admin/users`, {
    method: "POST",
    body: JSON.stringify({
      email: HOS_EMAIL,
      password: HOS_PASSWORD,
      email_confirm: true,
      user_metadata: { full_name: "Aylek HOS" },
    }),
  });
  console.log("    created auth user:", hosAuthUser.id);
}

// Make sure public.users row exists with role=admin
const existingProfile = await rest(`users?id=eq.${hosAuthUser.id}&select=*&limit=1`);
if (existingProfile.length === 0) {
  await rest(`users`, {
    method: "POST",
    body: JSON.stringify({
      id: hosAuthUser.id,
      email: HOS_EMAIL,
      full_name: "Aylek HOS",
      role: "admin",
    }),
  });
} else {
  await rest(`users?id=eq.${hosAuthUser.id}`, {
    method: "PATCH",
    body: JSON.stringify({ role: "admin", full_name: "Aylek HOS" }),
  });
}
console.log("    public.users row → role=admin");

// ─── 3. Sample leads for Acme Corp ─────────────────────────────────────────
console.log("\n[3/8] Sample leads (operator-imported → approved)");
const SAMPLE_LEADS = [
  { company_name: "Northwind Logistics", contact_name: "Sarah Chen", title: "Head of Operations", email: "sarah@northwind.example.com", industry: "Logistics" },
  { company_name: "Hargreaves & Co", contact_name: "Mitchell Clarke", title: "VP Sales", email: "mitch@hargreaves.example.com", industry: "Professional Services" },
  { company_name: "Parkside Studios", contact_name: "David Nguyen", title: "CEO", email: "dn@parkside.example.com", industry: "Media" },
  { company_name: "Meridian Health", contact_name: "Jade Morrison", title: "Director of Ops", email: "jade@meridianhealth.example.com", industry: "Healthcare" },
  { company_name: "Southside Tech", contact_name: "Tom Walsh", title: "Founder", email: "tom@southside.example.com", industry: "SaaS" },
];
const existingLeads = await rest(
  `leads?client_id=eq.${acme.id}&select=id,email,company_name,approval_status`,
);
const existingEmails = new Set(existingLeads.map((l) => l.email?.toLowerCase()).filter(Boolean));
const toInsert = SAMPLE_LEADS.filter(
  (l) => !existingEmails.has(l.email.toLowerCase()),
).map((l) => ({ ...l, client_id: acme.id, source: "import", stage: "new", approval_status: "approved" }));
let leads = existingLeads;
if (toInsert.length > 0) {
  const inserted = await rest(`leads`, {
    method: "POST",
    body: JSON.stringify(toInsert),
  });
  leads = [...existingLeads, ...inserted];
  console.log(`    inserted ${inserted.length} new (${existingLeads.length} already there)`);
} else {
  console.log(`    all ${SAMPLE_LEADS.length} already present`);
}

// ─── 3b. Agent-sourced leads → pending_approval + lead_list approval ───────
console.log("\n[3b/8] Agent-sourced leads (pending approval) + lead_list approval");
const AGENT_LEADS = [
  { company_name: "Verity Analytics", contact_name: "Priya Raman", title: "Head of Growth", email: "priya@verity.example.com", industry: "B2B SaaS" },
  { company_name: "Cobalt Robotics", contact_name: "Ben Foster", title: "VP Operations", email: "ben@cobalt.example.com", industry: "Robotics" },
  { company_name: "Linnaeus Bio", contact_name: "Mei Tanaka", title: "COO", email: "mei@linnaeus.example.com", industry: "Biotech" },
  { company_name: "Northstar Freight", contact_name: "Carlos Reyes", title: "Director, Sales", email: "carlos@northstar.example.com", industry: "Logistics" },
];
const agentExistingEmails = new Set(
  (await rest(`leads?email=in.(${AGENT_LEADS.map((l) => `"${l.email}"`).join(",")})&select=email`))
    .map((l) => l.email?.toLowerCase())
    .filter(Boolean),
);
const agentToInsert = AGENT_LEADS.filter(
  (l) => !agentExistingEmails.has(l.email.toLowerCase()),
).map((l) => ({
  ...l,
  client_id: acme.id,
  source: "ai_enriched",
  stage: "new",
  approval_status: "pending_approval",
}));
let agentLeads = [];
if (agentToInsert.length > 0) {
  agentLeads = await rest(`leads`, { method: "POST", body: JSON.stringify(agentToInsert) });
  console.log(`    inserted ${agentLeads.length} agent-sourced leads (pending_approval)`);
} else {
  agentLeads = await rest(
    `leads?client_id=eq.${acme.id}&source=eq.ai_enriched&approval_status=eq.pending_approval&select=id,company_name`,
  );
  console.log(`    ${agentLeads.length} already present`);
}

// Lead-list approval — only create if there's no pending one already.
// We pre-link it to the existing Acme campaign if one exists (or to whatever
// campaign id ends up created later in step 7). The approval card supports
// re-routing to a different campaign at approval time, so this is just a
// reasonable default.
const existingLeadListApproval = (
  await rest(
    `approvals?client_id=eq.${acme.id}&type=eq.lead_list&status=eq.pending&select=id&limit=1`,
  )
)[0];
const existingActiveCampaign = (
  await rest(
    `campaigns?client_id=eq.${acme.id}&status=neq.complete&select=id,name&order=created_at.desc&limit=1`,
  )
)[0];

if (!existingLeadListApproval && agentLeads.length > 0) {
  const leadListApproval = (
    await rest(`approvals`, {
      method: "POST",
      body: JSON.stringify({
        client_id: acme.id,
        type: "lead_list",
        status: "pending",
        title: `Prospect-01 sourced ${agentLeads.length} new leads`,
        summary: `${agentLeads.length} agent-sourced leads matching the approved ICP. Review and approve to enrol them${existingActiveCampaign ? ` into ${existingActiveCampaign.name}` : ""}.`,
        payload: {
          lead_ids: agentLeads.map((l) => l.id),
          source: "prospect-01",
          campaign_id: existingActiveCampaign?.id ?? null,
        },
        related_campaign_id: existingActiveCampaign?.id ?? null,
        created_by: hosAuthUser.id,
      }),
    })
  )[0];
  console.log(
    `    pending lead_list approval: ${leadListApproval.id}` +
      (existingActiveCampaign ? ` → ${existingActiveCampaign.name}` : " (no campaign yet — picker will surface)"),
  );
} else if (existingLeadListApproval) {
  console.log("    pending lead_list approval already exists:", existingLeadListApproval.id);
}

// ─── 4. Draft playbook ────────────────────────────────────────────────────
console.log("\n[4/8] Draft playbook");
let draft = (
  await rest(
    `playbooks?client_id=eq.${acme.id}&status=eq.draft&select=*&order=version.desc&limit=1`,
  )
)[0];
if (draft) {
  console.log("    draft already exists:", draft.id, "v" + draft.version);
} else {
  // bump version above any existing for this client
  const latest = (
    await rest(
      `playbooks?client_id=eq.${acme.id}&select=version&order=version.desc&limit=1`,
    )
  )[0];
  const nextVersion = (latest?.version ?? 0) + 1;
  draft = (
    await rest(`playbooks`, {
      method: "POST",
      body: JSON.stringify({
        client_id: acme.id,
        version: nextVersion,
        status: "draft",
        icp: {
          industries: ["B2B SaaS", "Logistics", "Healthcare"],
          company_size: "50–1000 employees",
          target_titles: ["Head of Operations", "VP Sales", "COO"],
          geography: ["ANZ", "North America"],
          qualification_signal: "Series B+ or 50+ employees, multi-region team",
          disqualifiers: ["Government", "Sub-10 staff", "Pre-seed"],
        },
        strategy: {
          value_proposition:
            "We run the entire B2B sales function as a service — playbook, outbound, inbound, CRM — so founders can stay heads-down on product.",
          key_messages: [
            "Closed-loop: every action is logged, every campaign is gated by an approved playbook.",
            "Industry-agnostic: same engine, your strategy + voice in the inputs.",
            "Hand-off ready: HOS approves before anything goes out, AI fills in between.",
          ],
          proof_points: [
            "Cuts time-to-first-meeting in half across two pilots.",
            "Replaces 1.5 SDRs in headcount on average for our retainer clients.",
          ],
          objection_responses: [
            { objection: "We have an in-house SDR.", response: "Great — we plug in alongside, take inbound + sequences, free their time for the deals worth their attention." },
            { objection: "Cold email never works for us.", response: "Most cold programmes fail on volume + voice. Ours starts with your playbook approved by you — we don't ship anything generic." },
          ],
        },
        voice_tone: {
          tone_descriptors: ["direct", "warm", "lowercase, no exclamation marks", "dry-witted"],
          writing_style:
            "Short sentences. Lowercase opening lines. Contractions encouraged. No corporate speak. Skip the 'I hope this email finds you well'.",
          avoid: ["jargon", "false urgency", "hype", "pricing in cold outreach", "exclamation marks"],
          example_phrases: [
            "worth a quick chat?",
            "no pitch — just curious if this is on your roadmap.",
            "happy to leave you alone if it's not the right time.",
          ],
        },
        reply_strategy: {
          interested: { action: "book a 20-minute discovery call", template: "Great to hear back. I have these slots open: <link>. If none work, hit me with two times that do." },
          not_now: { action: "snooze for 90 days, log reason", template: "Totally fair — I'll put it down for ~90 days. If anything changes, my line is always open." },
          wrong_person: { action: "ask for a redirect, mark current contact disqualified", template: "Apologies for the misfire. Who at {{company_name}} would this land with? Happy to take it from there." },
          unsubscribe: { action: "stage = unsubscribed; never email again", template: "" },
          objection: { action: "respond once with proof + offer to book; if no reply in 7d, stop", template: "Fair point — most teams we work with thought the same. <one proof point>. Worth 15 minutes to see if it lands for you?" },
        },
        team_members: [
          { id: cryptoId(), name: "Jesse Behrmann", title: "Head of Sales", email: "jesse@aylek.dev" },
          { id: cryptoId(), name: "Sarah Chen", title: "CEO, Acme Corp", email: "sarah@acme.example.com" },
        ],
        sales_process: [
          { id: "prospect", name: "Prospect", description: "Source and qualify leads matching the ICP.", agent: "prospect-01" },
          { id: "outreach", name: "Outreach", description: "Run the email sequence. Pause when a reply lands.", agent: "outreach-01" },
          { id: "book_meeting", name: "Book meeting", description: "Convert positive replies into a calendar booking.", agent: "scheduler-01" },
          { id: "have_meeting", name: "Have meeting", description: "Discovery call. Owned by a human rep.", agent: "human-rep" },
          { id: "send_proposal", name: "Send proposal", description: "Draft + send a proposal based on meeting notes.", agent: "proposal-01" },
          { id: "execute_contract", name: "Execute contract", description: "Send the contract, chase signatures.", agent: "contract-01" },
          { id: "payment", name: "Payment", description: "Issue invoice, confirm receipt.", agent: "billing-01" },
          { id: "onboard", name: "Onboard", description: "Kick-off call and onboarding tasks.", agent: "onboarding-01" },
          { id: "handover", name: "Handover", description: "Transition to account management / fulfilment.", agent: "account-mgmt" },
        ],
        sequences: [
          {
            step: 1, delay_days: 0, sender_index: 0,
            subject: "quick question about {{company_name}}",
            body: "hi {{contact_name}},\n\nI'm Jesse from Acme Corp. We help ops + sales leaders take outbound + inbound off their plate without growing headcount.\n\nNo pitch — curious if you're already running outbound, and how it's going. Worth a 15-minute chat?",
          },
          {
            step: 2, delay_days: 4, sender_index: 0,
            subject: "following up",
            body: "hi {{contact_name}},\n\nfollowing up on my note from earlier in the week. Most teams we talk to either run a single SDR underwater, or run nothing at all. Both can be expensive in different ways.\n\nWould a 15-minute look at how we run sales-as-a-service make sense?",
          },
          {
            step: 3, delay_days: 9, sender_index: 1,
            subject: "last note from me",
            body: "hi {{contact_name}},\n\nlast note. If now isn't right, no problem. If someone else at {{company_name}} owns growth or sales ops, I'd appreciate a redirect.\n\nThanks for the read.",
          },
        ],
        escalation_rules: [{ after_step: 3, action: "pause" }],
        channel_flags: { email: true, phone: false, linkedin: false },
        notes: "Seeded playbook — generic B2B SaaS scenario for smoke testing.",
      }),
    })
  )[0];
  console.log("    created:", draft.id, "v" + draft.version);
}

function cryptoId() {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return Math.random().toString(36).slice(2);
}

// ─── 5. Submit for approval ────────────────────────────────────────────────
console.log("\n[5/8] Submit playbook for approval");
let approval;
if (draft.status === "draft") {
  await rest(`playbooks?id=eq.${draft.id}`, {
    method: "PATCH",
    body: JSON.stringify({ status: "pending_approval", submitted_at: new Date().toISOString() }),
  });
  approval = (
    await rest(`approvals`, {
      method: "POST",
      body: JSON.stringify({
        client_id: acme.id,
        type: "strategy_change",
        status: "pending",
        title: `Playbook v${draft.version} submitted`,
        summary: `Acme Corp: ${draft.sequences.length}-step sequence (seeded)`,
        payload: {
          playbook_id: draft.id,
          mode: "promote_draft",
          version: draft.version,
          source: "seed_script",
        },
        related_playbook_id: draft.id,
        created_by: hosAuthUser.id,
      }),
    })
  )[0];
  console.log("    approval row:", approval.id);
} else {
  approval = (
    await rest(
      `approvals?related_playbook_id=eq.${draft.id}&status=eq.pending&select=*&limit=1`,
    )
  )[0];
  if (approval) {
    console.log("    existing pending approval:", approval.id);
  } else {
    console.log("    playbook is", draft.status, "and no pending approval — skipping submit");
  }
}

// ─── 6. Approve it ─────────────────────────────────────────────────────────
console.log("\n[6/8] Approve playbook");
if (approval) {
  // Demote any prior approved playbook for this client to keep the unique invariant
  await rest(
    `playbooks?client_id=eq.${acme.id}&status=eq.approved&id=neq.${draft.id}`,
    { method: "PATCH", body: JSON.stringify({ status: "draft" }) },
  );

  await rest(`playbooks?id=eq.${draft.id}`, {
    method: "PATCH",
    body: JSON.stringify({
      status: "approved",
      approved_by: hosAuthUser.id,
      approved_at: new Date().toISOString(),
    }),
  });
  await rest(`approvals?id=eq.${approval.id}`, {
    method: "PATCH",
    body: JSON.stringify({
      status: "approved",
      approved_by: hosAuthUser.id,
      decided_at: new Date().toISOString(),
    }),
  });
  console.log("    approved");
} else {
  // Already approved? Find it.
  const existing = (
    await rest(
      `playbooks?client_id=eq.${acme.id}&status=eq.approved&select=id,version&limit=1`,
    )
  )[0];
  if (existing) {
    console.log("    playbook v" + existing.version + " already approved:", existing.id);
  } else {
    console.log("    WARN: no approved playbook for Acme — campaign launch will be blocked");
  }
}

// ─── 7. Create + launch a campaign ────────────────────────────────────────
console.log("\n[7/8] Create + launch campaign");
let campaign = (
  await rest(
    `campaigns?client_id=eq.${acme.id}&name=eq.Acme%20Q2%20Outreach&select=*&limit=1`,
  )
)[0];
if (!campaign) {
  // Pull the approved playbook so the campaign uses its sequence
  const approved = (
    await rest(
      `playbooks?client_id=eq.${acme.id}&status=eq.approved&select=*&limit=1`,
    )
  )[0];
  if (!approved) {
    console.log("    skipping — no approved playbook");
  } else {
    campaign = (
      await rest(`campaigns`, {
        method: "POST",
        body: JSON.stringify({
          client_id: acme.id,
          name: "Acme Q2 Outreach",
          status: "draft",
          target_industry: "B2B SaaS",
          target_title: "Head of Operations",
          sequence_steps: approved.sequences,
          created_by: hosAuthUser.id,
        }),
      })
    )[0];
    console.log("    created campaign:", campaign.id);

    // Queue step-1 email per eligible lead
    const eligible = leads.filter((l) => l.email && l.company_name);
    const now = new Date().toISOString();
    const firstStep =
      approved.sequences.find((s) => s.step === 1) ?? approved.sequences[0];
    const emailRows = eligible.map((l) => ({
      lead_id: l.id,
      client_id: acme.id,
      campaign_id: campaign.id,
      direction: "outbound",
      step_number: firstStep.step,
      subject: firstStep.subject
        .replace(/\{\{\s*company_name\s*\}\}/gi, l.company_name)
        .replace(/\{\{\s*contact_name\s*\}\}/gi, l.contact_name?.split(" ")[0] ?? "there"),
      body: firstStep.body
        .replace(/\{\{\s*company_name\s*\}\}/gi, l.company_name)
        .replace(/\{\{\s*contact_name\s*\}\}/gi, l.contact_name?.split(" ")[0] ?? "there"),
      status: "pending",
      send_at: now,
    }));
    if (emailRows.length > 0) {
      await rest(`emails`, { method: "POST", body: JSON.stringify(emailRows) });
    }

    // Activate the campaign — DB hard gate fires here. If this throws, the seed
    // bails out clearly.
    await rest(`campaigns?id=eq.${campaign.id}`, {
      method: "PATCH",
      body: JSON.stringify({ status: "active", leads_enrolled: eligible.length }),
    });
    console.log(`    activated, ${eligible.length} leads enrolled, ${emailRows.length} emails queued`);
  }
} else {
  console.log("    campaign already exists:", campaign.id, campaign.status);
}

// ─── 8. Summary ────────────────────────────────────────────────────────────
console.log("\n[8/8] Summary");
const counts = {
  clients: (await rest(`clients?select=id&id=eq.${acme.id}`)).length,
  leads: (await rest(`leads?select=id&client_id=eq.${acme.id}`)).length,
  playbooks: (await rest(`playbooks?select=id,version,status&client_id=eq.${acme.id}`)),
  approvals: (await rest(`approvals?select=id,type,status&client_id=eq.${acme.id}`)),
  campaigns: (await rest(`campaigns?select=id,name,status&client_id=eq.${acme.id}`)),
  emails: (await rest(`emails?select=id&client_id=eq.${acme.id}`)).length,
};
console.log(JSON.stringify(counts, null, 2));

console.log("\n✓ Seed complete. Sign in with hos@aylek.dev / Aylek123! (or your admin account) and visit /clients/" + acme.id);
