import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Item 6 — bulk approve/reject auto-finalisation.
 *
 * Scenario: a `lead_list` approval batch contains 10 pending leads. HOS
 * rejects 7 in one bulk call, then approves the remaining 3 in a second
 * bulk call. The parent approval must auto-finalise to `approved` on the
 * second call AND a `lead_list_auto_finalised` event must be logged.
 *
 * We mock at the lib boundary (auth, events, supabase server client) the
 * same way icp-translator.test.ts forces deterministic behaviour. The
 * supabase mock is a tiny chainable builder that pops responses off a
 * queue in the order the action calls them — keeps the test readable
 * without re-implementing PostgREST.
 */

const mocks = vi.hoisted(() => ({
  requireUser: vi.fn(),
  logEvent: vi.fn(),
  revalidatePath: vi.fn(),
  queue: [] as Array<{ data?: unknown; error?: { message: string } | null; count?: number | null }>,
  fromCalls: [] as Array<{ table: string }>,
}));

vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidatePath }));
vi.mock("@/lib/auth", () => ({ requireUser: mocks.requireUser }));
vi.mock("@/lib/events", () => ({ logEvent: mocks.logEvent }));

vi.mock("@/lib/supabase/server", () => ({
  createClient: () => ({
    from(table: string) {
      mocks.fromCalls.push({ table });
      const b: Record<string, unknown> = {};
      const chain = () => b;
      b.select = chain;
      b.update = chain;
      b.insert = chain;
      b.delete = chain;
      b.in = chain;
      b.eq = chain;
      b.then = (
        resolve: (v: unknown) => unknown,
        reject?: (e: unknown) => unknown,
      ) => {
        const r = mocks.queue.shift() ?? {};
        return Promise.resolve(r).then(resolve, reject);
      };
      return b;
    },
  }),
  createServiceClient: () => ({
    from() {
      const b: Record<string, unknown> = {};
      const chain = () => b;
      b.select = chain;
      b.update = chain;
      b.insert = chain;
      b.in = chain;
      b.eq = chain;
      b.then = (resolve: (v: unknown) => unknown) => Promise.resolve({}).then(resolve);
      return b;
    },
  }),
}));

import { bulkApproveLeads, bulkRejectLeads } from "@/app/(dashboard)/leads/actions";

// Valid UUID v4s for the zod schema.
function uuid(i: number): string {
  const hex = i.toString(16).padStart(8, "0");
  return `${hex}-0000-4000-8000-000000000000`;
}

const LEAD_IDS = Array.from({ length: 10 }, (_, i) => uuid(i + 1));
const APPROVAL_ID = "abcdef00-1111-4222-8333-444455556666";
const CLIENT_ID = "11111111-2222-4333-8444-555566667777";

beforeEach(() => {
  mocks.requireUser.mockReset();
  mocks.logEvent.mockReset();
  mocks.revalidatePath.mockReset();
  mocks.requireUser.mockResolvedValue({ auth: { id: "hos-user-id" } });
  mocks.logEvent.mockResolvedValue(undefined);
  mocks.queue.length = 0;
  mocks.fromCalls.length = 0;
});

describe("Item 6 — bulkRejectLeads + bulkApproveLeads auto-finalise the parent lead_list", () => {
  it("rejects 7 then approves 3 → parent batch of 10 flips to approved with auto-finalised event", async () => {
    // ── Run 1: reject the first 7 leads ────────────────────────────────
    // Calls (in order) inside bulkDecideLeads:
    //   1. update leads.approval_status='rejected'    → { count: 7 }
    //   2. select leads.client_id (for the event log) → 7 rows
    //   3. select pending lead_list approvals         → the batch
    //   4. select leads (head, count: still pending)  → 3 (the unrejected
    //      subset is still pending) ⇒ NO auto-finalise
    mocks.queue.push(
      { count: 7, error: null },
      {
        data: LEAD_IDS.slice(0, 7).map(() => ({ client_id: CLIENT_ID })),
        error: null,
      },
      {
        data: [
          {
            id: APPROVAL_ID,
            type: "lead_list",
            status: "pending",
            payload: { lead_ids: LEAD_IDS },
            client_id: CLIENT_ID,
            related_campaign_id: null,
            created_at: new Date().toISOString(),
          },
        ],
        error: null,
      },
      { count: 3 },
    );

    const r1 = await bulkRejectLeads({ lead_ids: LEAD_IDS.slice(0, 7) });
    expect(r1.ok).toBe(true);
    if (!r1.ok) throw new Error("guard");
    expect(r1.updated).toBe(7);
    expect(r1.finalised_approval_ids).toEqual([]);

    // No auto-finalised event yet — only the bulk reject event per client.
    const rejectEvents = mocks.logEvent.mock.calls.map((c) => c[0] as { payload?: { kind?: string } });
    expect(rejectEvents.some((e) => e.payload?.kind === "lead_list_auto_finalised")).toBe(false);
    expect(rejectEvents.some((e) => e.payload?.kind === "approval_rejected")).toBe(true);

    // ── Run 2: approve the remaining 3 leads ───────────────────────────
    // Same 4 calls + one extra `update approvals` to mark the parent
    // approved when stillPendingCount === 0.
    mocks.queue.push(
      { count: 3, error: null },
      {
        data: LEAD_IDS.slice(7).map(() => ({ client_id: CLIENT_ID })),
        error: null,
      },
      {
        data: [
          {
            id: APPROVAL_ID,
            type: "lead_list",
            status: "pending",
            payload: { lead_ids: LEAD_IDS },
            client_id: CLIENT_ID,
            related_campaign_id: null,
            created_at: new Date().toISOString(),
          },
        ],
        error: null,
      },
      { count: 0 }, // every lead in the batch is now decided
      { error: null }, // update approvals → approved
    );

    const r2 = await bulkApproveLeads({ lead_ids: LEAD_IDS.slice(7) });
    expect(r2.ok).toBe(true);
    if (!r2.ok) throw new Error("guard");
    expect(r2.updated).toBe(3);
    expect(r2.finalised_approval_ids).toEqual([APPROVAL_ID]);

    // Auto-finalised event must be emitted with approval_id + via.
    const allEvents = mocks.logEvent.mock.calls.map((c) => c[0] as {
      event_type?: string;
      client_id?: string | null;
      payload?: { kind?: string; approval_id?: string; via?: string };
    });
    const finalise = allEvents.find((e) => e.payload?.kind === "lead_list_auto_finalised");
    expect(finalise).toBeDefined();
    expect(finalise?.payload?.approval_id).toBe(APPROVAL_ID);
    expect(finalise?.payload?.via).toBe("bulk_action");
    expect(finalise?.client_id).toBe(CLIENT_ID);

    // And the approve event for run 2 should also have been logged.
    expect(allEvents.some((e) => e.payload?.kind === "lead_list_approved")).toBe(true);
  });

  it("does NOT auto-finalise when leads outside the bulk set are still pending", async () => {
    // Approve only 5 of 10. The remaining 5 stay pending → parent stays
    // pending → no auto-finalised event.
    mocks.queue.push(
      { count: 5, error: null },
      {
        data: LEAD_IDS.slice(0, 5).map(() => ({ client_id: CLIENT_ID })),
        error: null,
      },
      {
        data: [
          {
            id: APPROVAL_ID,
            type: "lead_list",
            status: "pending",
            payload: { lead_ids: LEAD_IDS },
            client_id: CLIENT_ID,
            related_campaign_id: null,
            created_at: new Date().toISOString(),
          },
        ],
        error: null,
      },
      { count: 5 }, // 5 still pending → no finalise
    );

    const r = await bulkApproveLeads({ lead_ids: LEAD_IDS.slice(0, 5) });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("guard");
    expect(r.finalised_approval_ids).toEqual([]);

    const events = mocks.logEvent.mock.calls.map((c) => c[0] as { payload?: { kind?: string } });
    expect(events.some((e) => e.payload?.kind === "lead_list_auto_finalised")).toBe(false);
  });

  it("validates input — rejects empty arrays and oversized batches", async () => {
    const empty = await bulkApproveLeads({ lead_ids: [] });
    expect(empty.ok).toBe(false);

    const toMany = await bulkApproveLeads({
      lead_ids: Array.from({ length: 501 }, (_, i) => uuid(i + 1)),
    });
    expect(toMany.ok).toBe(false);
  });
});
