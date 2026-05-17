import { describe, it, expect } from "vitest";
import { applyRunToSegment } from "@/lib/segments";
import { ensureSegments } from "@/lib/onboarding";
import type { GeneratedPlaybookDraft, PlaybookSegment } from "@/lib/supabase/types";

/**
 * Item 7 — pure-function tests for the segment helpers.
 *
 * The full segment-aware Prospect-01 run is verified manually (real
 * Apollo + Supabase wiring); these tests pin down the math so future
 * refactors don't accidentally re-introduce the off-by-one + status
 * flip bugs that bit us mid-build.
 */

function baseSegment(overrides: Partial<PlaybookSegment> = {}): PlaybookSegment {
  return {
    id: "seg_001",
    name: "Independent restaurants in Sydney",
    description: "Family-owned single-location restaurants.",
    icp: { industries: ["Food & Beverage"], target_titles: ["Owner"] },
    value_angle: "Distinct pitch.",
    estimated_pool_size: 200,
    status: "active",
    performance_score: null,
    runs_completed: 0,
    leads_remaining: 200,
    ...overrides,
  };
}

describe("applyRunToSegment — pool depletion math", () => {
  it("decrements leads_remaining by the number sourced + ticks runs_completed", () => {
    const out = applyRunToSegment(baseSegment(), 50);
    expect(out.leads_remaining).toBe(150);
    expect(out.runs_completed).toBe(1);
    expect(out.status).toBe("active");
  });

  it("flips status to 'exhausted' when leads_remaining hits 0", () => {
    const out = applyRunToSegment(baseSegment({ leads_remaining: 30 }), 30);
    expect(out.leads_remaining).toBe(0);
    expect(out.status).toBe("exhausted");
  });

  it("clamps leads_remaining at 0 if the run over-sources (Apollo de-dup edge)", () => {
    const out = applyRunToSegment(baseSegment({ leads_remaining: 10 }), 25);
    expect(out.leads_remaining).toBe(0);
    expect(out.status).toBe("exhausted");
  });

  it("falls back to estimated_pool_size − sourced when leads_remaining is missing", () => {
    // Simulate a pre-Item-7 segment imported with no leads_remaining.
    const seg = baseSegment({
      estimated_pool_size: 100,
      leads_remaining: undefined as unknown as number,
    });
    const out = applyRunToSegment(seg, 40);
    // priorRemaining = max(0, 100-40) = 60 → leads_remaining = 60 - 40 = 20
    expect(out.leads_remaining).toBe(20);
    expect(out.status).toBe("active");
  });

  it("preserves the existing status (rejected, exhausted) when remaining > 0", () => {
    // Segments that aren't active still shouldn't have their status
    // silently flipped by a run. Prospect-01 gates on status before
    // reaching this helper, but defence-in-depth.
    const r = applyRunToSegment(baseSegment({ status: "rejected" }), 10);
    expect(r.status).toBe("rejected");
    expect(r.leads_remaining).toBe(190);
  });

  it("treats fractional / negative sourced counts as floored to >= 0", () => {
    expect(applyRunToSegment(baseSegment(), -5).leads_remaining).toBe(200);
    expect(applyRunToSegment(baseSegment(), 12.7).leads_remaining).toBe(188);
  });

  it("monotonically ticks runs_completed across N sequential calls", () => {
    let seg = baseSegment();
    for (let i = 1; i <= 4; i++) {
      const out = applyRunToSegment(seg, 10);
      expect(out.runs_completed).toBe(i);
      seg = { ...seg, runs_completed: out.runs_completed, leads_remaining: out.leads_remaining };
    }
    // 4 runs × 10 sourced each → 200 - 40 = 160 leads_remaining
    expect(seg.leads_remaining).toBe(160);
  });
});

describe("ensureSegments — defensive normalisation", () => {
  function bareDraft(): GeneratedPlaybookDraft {
    return {
      icp: {
        industries: ["Food & Beverage"],
        target_titles: ["Owner"],
        geography: ["Sydney, Australia"],
      },
      strategy: { value_proposition: "Help cafes win their first 20 reviews." },
      voice_tone: {},
      reply_strategy: {},
      team_members: [],
      sales_process: [],
      sequences: [],
    };
  }

  it("synthesises a single seed segment when Claude returned none", () => {
    const out = ensureSegments(bareDraft());
    expect(out.segments?.length).toBe(1);
    expect(out.segments![0].id).toBe("seg_001");
    expect(out.segments![0].status).toBe("pending_approval");
    expect(out.segments![0].name).toContain("Food & Beverage");
  });

  it("normalises Claude-returned segments — fills missing ids, defaults pool size, clamps statuses", () => {
    const draft: GeneratedPlaybookDraft = {
      ...bareDraft(),
      segments: [
        // missing id → should get seg_001
        {
          name: "Independent cafes",
          description: "",
          icp: { industries: ["Cafes"] },
          value_angle: "",
          estimated_pool_size: 500,
          status: "pending_approval",
          performance_score: null,
          runs_completed: 0,
          leads_remaining: 500,
        } as unknown as PlaybookSegment,
        // unknown status string → coerced to pending_approval
        {
          id: "seg_002",
          name: "Hotel F&B",
          description: "",
          icp: {},
          value_angle: "",
          estimated_pool_size: 150,
          status: "totally_made_up_status" as unknown as PlaybookSegment["status"],
          performance_score: null,
          runs_completed: 0,
          leads_remaining: 150,
        },
        // entirely malformed (no name) → dropped
        { id: "seg_003" } as unknown as PlaybookSegment,
      ],
    };
    const out = ensureSegments(draft);
    expect(out.segments?.length).toBe(2);
    expect(out.segments![0].id).toBe("seg_001");
    expect(out.segments![1].id).toBe("seg_002");
    expect(out.segments![1].status).toBe("pending_approval");
  });

  it("derives leads_remaining = estimated_pool_size when the field is missing", () => {
    const draft: GeneratedPlaybookDraft = {
      ...bareDraft(),
      segments: [
        {
          id: "seg_001",
          name: "Wine bars",
          description: "",
          icp: {},
          value_angle: "",
          estimated_pool_size: 80,
          status: "pending_approval",
          performance_score: null,
          runs_completed: 0,
        } as unknown as PlaybookSegment,
      ],
    };
    const out = ensureSegments(draft);
    expect(out.segments![0].leads_remaining).toBe(80);
  });
});
