/**
 * Item 7 — pure helpers for per-segment pool tracking.
 *
 * Lives outside lib/agents/prospect-01.ts so it can be unit-tested
 * without pulling in the Apollo / Hunter / Supabase wiring. The
 * segment-aware Prospect-01 run uses `applyRunToSegment` directly.
 */

import type { PlaybookSegment } from "@/lib/supabase/types";

export type SegmentRunDelta = {
  segment: PlaybookSegment;
  runs_completed: number;
  leads_remaining: number;
  status: PlaybookSegment["status"];
};

/**
 * Compute the post-run state of a segment given the number of leads the
 * run sourced into it. Returns the next runs_completed + leads_remaining
 * + (possibly flipped) status. Idempotent in the sense that callers can
 * compose this into a `.map()` without worrying about extra side
 * effects — the only writes happen in the supabase-touching caller.
 *
 * Status rules:
 *  - if leads_remaining is null/undefined we fall back to
 *    estimated_pool_size - sourced (so first-ever runs still tick).
 *  - clamp leads_remaining at 0 (Prospect-01 over-sources happen — Apollo
 *    sometimes returns more than the cap we ask for after dedup).
 *  - flip status to 'exhausted' when leads_remaining hits 0. Otherwise
 *    leave status untouched (e.g. a rejected segment passed in stays
 *    rejected; an active one stays active).
 */
export function applyRunToSegment(
  segment: PlaybookSegment,
  leadsSourced: number,
): SegmentRunDelta {
  const sourced = Math.max(0, Math.floor(leadsSourced));
  const priorRemaining =
    typeof segment.leads_remaining === "number" && Number.isFinite(segment.leads_remaining)
      ? segment.leads_remaining
      : Math.max(0, segment.estimated_pool_size - sourced);
  const leads_remaining = Math.max(0, priorRemaining - sourced);
  const runs_completed = (segment.runs_completed ?? 0) + 1;
  const status: PlaybookSegment["status"] =
    leads_remaining <= 0 ? "exhausted" : segment.status;
  return { segment, runs_completed, leads_remaining, status };
}
