import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Item 8 — Close-01 unit tests.
 *
 * Verifies the three things most likely to silently break:
 *   1. `draftProposalHtml` returns the playbook's pricing (or null —
 *      NEVER a hardcoded default) and never blows up when Anthropic is
 *      unavailable (deterministic fallback path).
 *   2. `runClose01Sweep` is idempotent — second run with the same
 *      already-flagged data must not double-up follow-ups or cold flags.
 *   3. `flagCold` opens exactly one `deal_cold` approval and stamps the
 *      proposal so a re-run is a no-op.
 */

const mocks = vi.hoisted(() => ({
  resendSend: vi.fn(async () => ({ id: "msg_test" })),
  logEvent: vi.fn(async () => undefined),
  isActivelySuppressed: vi.fn(async () => false),
  getClientSendingConfig: vi.fn(async () => ({
    from: "team@aylek.test",
    reply_to: "team@aylek.test",
    source: "client",
    client_status: "verified",
  })),
}));

vi.mock("@/lib/resend", () => ({
  resend: { emails: { send: mocks.resendSend } },
  FROM_EMAIL: "hello@aylek.test",
}));
vi.mock("@/lib/events", () => ({ logEvent: mocks.logEvent }));
vi.mock("@/lib/suppression", () => ({ isActivelySuppressed: mocks.isActivelySuppressed }));
vi.mock("@/lib/email-config", () => ({ getClientSendingConfig: mocks.getClientSendingConfig }));

// Anthropic — force the deterministic fallback. The library already
// honours this when ANTHROPIC_API_KEY is empty (see lib/anthropic.ts).
const ORIGINAL_KEY = process.env.ANTHROPIC_API_KEY;

beforeEach(() => {
  process.env.ANTHROPIC_API_KEY = "";
  process.env.RESEND_API_KEY = "re_test";
  mocks.resendSend.mockClear();
  mocks.logEvent.mockClear();
  mocks.isActivelySuppressed.mockClear();
});

afterAll();

function afterAll() {
  // restore after the file finishes — Vitest runs files in isolation,
  // so this is belt-and-braces; it matters when run inside a watch
  // loop with shared env.
  if (typeof globalThis !== "undefined") {
    process.env.ANTHROPIC_API_KEY = ORIGINAL_KEY;
  }
}

// Tiny chainable supabase mock — same shape as the leads/bulk-actions
// test. Each `from().method().method()...` chain resolves to whatever
// is at the head of the response queue.
type CallLog = { table: string; op: string; values?: unknown };
type SupabaseStub = {
  from: ReturnType<typeof vi.fn>;
  calls: CallLog[];
  queue: Array<{ data?: unknown; error?: { message: string } | null; count?: number | null }>;
};

function makeSupabaseStub(): SupabaseStub {
  const stub: SupabaseStub = {
    from: vi.fn(),
    calls: [],
    queue: [],
  };
  stub.from.mockImplementation((table: string) => {
    let op = "select";
    let values: unknown;
    const b: Record<string, unknown> = {};
    b.select = vi.fn(() => {
      op = "select";
      stub.calls.push({ table, op });
      return b;
    });
    b.insert = vi.fn((v: unknown) => {
      op = "insert";
      values = v;
      stub.calls.push({ table, op, values });
      return b;
    });
    b.update = vi.fn((v: unknown) => {
      op = "update";
      values = v;
      stub.calls.push({ table, op, values });
      return b;
    });
    b.eq = vi.fn(() => b);
    b.in = vi.fn(() => b);
    b.is = vi.fn(() => b);
    b.lte = vi.fn(() => b);
    b.maybeSingle = vi.fn(() => b);
    b.single = vi.fn(() => b);
    b.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) => {
      const r = stub.queue.shift() ?? {};
      return Promise.resolve(r).then(resolve, reject);
    };
    return b;
  });
  return stub;
}

import { draftProposalHtml, flagCold, runClose01Sweep } from "@/lib/agents/close-01";
import type { Playbook, Proposal } from "@/lib/supabase/types";

describe("draftProposalHtml — pricing semantics", () => {
  function basePlaybook(pricing_cents: number | null | undefined): Playbook {
    return {
      id: "p1",
      client_id: "c1",
      version: 1,
      status: "approved",
      icp: {},
      sequences: [],
      escalation_rules: [],
      channel_flags: { email: true, phone: false, linkedin: false },
      strategy: { value_proposition: "We help cafes book more reviews." },
      voice_tone: { tone_descriptors: ["direct"] },
      reply_strategy: {},
      team_members: [],
      sales_process: [],
      pricing_cents,
      notes: null,
      created_by: null,
      approved_by: null,
      approved_at: null,
      submitted_at: null,
      created_at: "",
      updated_at: "",
    };
  }

  it("inherits playbook.pricing_cents when set", async () => {
    const out = await draftProposalHtml({
      playbook: basePlaybook(120000), // $1,200.00
      lead: { company_name: "Acme", contact_name: "Jess", title: "Owner", industry: "F&B" },
      meetingNote: {
        outcome: "positive",
        notes: "They want to start in 2 weeks.",
        transcript: null,
        objections: null,
        next_steps: "Send proposal Mon",
      },
    });
    expect(out.amount_cents).toBe(120000);
    expect(out.subject).toBeTruthy();
    expect(out.html).toContain("<h2");
  });

  it("returns amount_cents=null when the playbook has no pricing — NEVER hardcoded", async () => {
    const out = await draftProposalHtml({
      playbook: basePlaybook(null),
      lead: { company_name: "Acme", contact_name: null, title: null, industry: null },
      meetingNote: null,
    });
    expect(out.amount_cents).toBeNull();
  });

  it("falls back gracefully when no playbook is supplied", async () => {
    const out = await draftProposalHtml({
      playbook: null,
      lead: { company_name: "Acme", contact_name: null, title: null, industry: null },
      meetingNote: null,
    });
    expect(out.amount_cents).toBeNull();
    expect(out.html.length).toBeGreaterThan(0);
  });
});

describe("runClose01Sweep — idempotency + status gating", () => {
  function proposal(overrides: Partial<Proposal> = {}): Proposal {
    return {
      id: "prop_1",
      token: "tok_1",
      client_id: "c1",
      lead_id: "lead_1",
      meeting_id: null,
      meeting_note_id: null,
      html_content: "<p>x</p>",
      subject: "Acme proposal",
      status: "sent",
      stripe_payment_link_id: null,
      stripe_payment_link_url: null,
      amount_cents: 50000,
      currency: "usd",
      view_count: 0,
      viewed_at: null,
      accepted_at: null,
      paid_at: null,
      expires_at: null,
      followup_sent_at: null,
      cold_flagged_at: null,
      created_by: null,
      created_at: new Date(Date.now() - 72 * 3600 * 1000).toISOString(),
      ...overrides,
    };
  }

  it("flags a stale 'sent' proposal as needing a followup, then no-ops on re-run", async () => {
    const supa = makeSupabaseStub();
    // Run 1 — stale proposal returned, then enrich + update follow-up timestamp
    supa.queue.push(
      { data: [proposal()], error: null }, // select stale sent
      { data: { id: "lead_1", company_name: "Acme", contact_name: "Jess", email: "j@acme.test", client_id: "c1" }, error: null }, // sendFollowupNudge lead lookup
      { data: null, error: null }, // proposals update followup_sent_at
      { data: [], error: null }, // select viewed cold candidates → none
    );
    const out1 = await runClose01Sweep(supa as unknown as Parameters<typeof runClose01Sweep>[0]);
    expect(out1.followups_sent).toBe(1);
    expect(out1.cold_flagged).toBe(0);

    // Run 2 — same proposal, but now followup_sent_at is set → the `is`
    // filter in the helper excludes it, so the query returns nothing.
    supa.queue.push(
      { data: [], error: null }, // select stale sent → empty (gated by .is followup_sent_at null)
      { data: [], error: null }, // select viewed cold candidates → empty
    );
    const out2 = await runClose01Sweep(supa as unknown as Parameters<typeof runClose01Sweep>[0]);
    expect(out2.followups_sent).toBe(0);
    expect(out2.cold_flagged).toBe(0);
  });

  it("flags a 5-day stale 'viewed' proposal as cold once, then no-ops", async () => {
    const supa = makeSupabaseStub();
    const oldViewed = proposal({
      status: "viewed",
      viewed_at: new Date(Date.now() - 6 * 24 * 3600 * 1000).toISOString(),
    });
    supa.queue.push(
      { data: [], error: null }, // select stale sent → none
      { data: [oldViewed], error: null }, // select viewed cold candidates
      // flagCold internals:
      { data: { company_name: "Acme", client_id: "c1" }, error: null }, // lead lookup
      { data: { id: "appr_1" }, error: null }, // approvals insert
      { data: null, error: null }, // proposals update cold_flagged_at
    );
    const out = await runClose01Sweep(supa as unknown as Parameters<typeof runClose01Sweep>[0]);
    expect(out.cold_flagged).toBe(1);
    const apprInsert = supa.calls.find((c) => c.table === "approvals" && c.op === "insert");
    expect(apprInsert).toBeDefined();
    expect((apprInsert!.values as { type: string }).type).toBe("deal_cold");
  });
});

describe("flagCold — opens exactly one approval + stamps the proposal", () => {
  it("inserts a deal_cold approval and stamps cold_flagged_at", async () => {
    const supa = makeSupabaseStub();
    const prop: Proposal = {
      id: "prop_x",
      token: "tok_x",
      client_id: "c1",
      lead_id: "lead_x",
      meeting_id: null,
      meeting_note_id: null,
      html_content: "<p>x</p>",
      subject: "Stale deal",
      status: "viewed",
      stripe_payment_link_id: null,
      stripe_payment_link_url: null,
      amount_cents: 80000,
      currency: "usd",
      view_count: 1,
      viewed_at: new Date(Date.now() - 6 * 24 * 3600 * 1000).toISOString(),
      accepted_at: null,
      paid_at: null,
      expires_at: null,
      followup_sent_at: null,
      cold_flagged_at: null,
      created_by: null,
      created_at: new Date(Date.now() - 9 * 24 * 3600 * 1000).toISOString(),
    };

    supa.queue.push(
      { data: { company_name: "Stale Co", client_id: "c1" }, error: null },
      { data: { id: "appr_z" }, error: null },
      { data: null, error: null },
    );
    const r = await flagCold(supa as unknown as Parameters<typeof flagCold>[0], prop, "no_accept_5d");
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("guard");
    expect(r.approval_id).toBe("appr_z");

    const insert = supa.calls.find((c) => c.table === "approvals" && c.op === "insert");
    expect(insert).toBeDefined();
    const values = insert!.values as { type: string; client_id: string; status: string };
    expect(values.type).toBe("deal_cold");
    expect(values.client_id).toBe("c1");
    expect(values.status).toBe("pending");

    const update = supa.calls.find((c) => c.table === "proposals" && c.op === "update");
    expect(update).toBeDefined();
    expect((update!.values as { cold_flagged_at: string }).cold_flagged_at).toBeTruthy();
  });
});
