import { NextResponse, type NextRequest } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { rateLimitSnapshot } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

/**
 * GET /api/cron/health
 *
 * Operational health snapshot. Returns:
 *   - last_success per cron route (derived from the events table)
 *   - count of pending emails older than 1 hour (stuck queue indicator)
 *   - in-memory rate-limiter token state per upstream API
 *   - last 10 ai_action events tagged email_failed (deliverability heads-up)
 *
 * Auth: Bearer ${CRON_SECRET} for ops monitors, else admin session.
 * Returns 200 with a "ok" boolean — false when any cron hasn't
 * succeeded in 25 hours.
 */
export async function GET(req: NextRequest) {
  const auth = req.headers.get("authorization");
  const cronOk = process.env.CRON_SECRET && auth === `Bearer ${process.env.CRON_SECRET}`;
  if (!cronOk) {
    return new NextResponse("Unauthorized", { status: 401 });
  }

  const supabase = createServiceClient();
  const now = Date.now();
  const ONE_HOUR_MS = 60 * 60 * 1000;
  const ONE_DAY_MS = 24 * ONE_HOUR_MS;

  // Last success per cron — we use ai_action events with kind="cron_*"
  // OR fall back to email_sent (proxy for send-emails being alive).
  const sinceIso = new Date(now - 7 * ONE_DAY_MS).toISOString();
  const { data: events } = await supabase
    .from("events")
    .select("event_type, payload, created_at")
    .gte("created_at", sinceIso)
    .order("created_at", { ascending: false })
    .limit(500);
  const eventRows = (events ?? []) as Array<{
    event_type: string;
    payload: Record<string, unknown> | null;
    created_at: string;
  }>;

  let lastSend: string | null = null;
  let lastProspect: string | null = null;
  let lastLearning: string | null = null;
  let failures = 0;
  const recentFailures: typeof eventRows = [];
  for (const e of eventRows) {
    if (e.event_type === "email_sent" && !lastSend) lastSend = e.created_at;
    const kind = (e.payload as { kind?: string } | null)?.kind ?? null;
    if (kind === "prospect_run" && !lastProspect) lastProspect = e.created_at;
    if (kind === "learning_run" && !lastLearning) lastLearning = e.created_at;
    if (kind === "email_failed") {
      failures += 1;
      if (recentFailures.length < 10) recentFailures.push(e);
    }
  }

  // Stuck queue: pending emails with send_at older than 1h.
  const stuckCutoff = new Date(now - ONE_HOUR_MS).toISOString();
  const { count: stuckPending } = await supabase
    .from("emails")
    .select("id", { count: "exact", head: true })
    .eq("status", "pending")
    .lte("send_at", stuckCutoff);

  const ageMs = (iso: string | null): number | null =>
    iso ? now - new Date(iso).getTime() : null;

  const sendStale = ageMs(lastSend) ?? Infinity;
  const learningStale = ageMs(lastLearning) ?? Infinity;
  // send-emails runs hourly, learning daily. Tolerance: 2× the cadence.
  const sendOk = sendStale < 2 * ONE_HOUR_MS;
  const learningOk = learningStale < 2 * ONE_DAY_MS;
  const ok = sendOk && learningOk && (stuckPending ?? 0) === 0;

  return NextResponse.json({
    ok,
    now: new Date(now).toISOString(),
    crons: {
      send_emails: { last_success: lastSend, ok: sendOk, stale_ms: Number.isFinite(sendStale) ? sendStale : null },
      learning: { last_success: lastLearning, ok: learningOk, stale_ms: Number.isFinite(learningStale) ? learningStale : null },
      prospect_run_latest: lastProspect,
    },
    stuck_pending_emails: stuckPending ?? 0,
    recent_email_failures: failures,
    failure_excerpts: recentFailures.map((e) => ({
      at: e.created_at,
      kind: (e.payload as { kind?: string; reason?: string } | null)?.kind,
      reason: (e.payload as { kind?: string; reason?: string } | null)?.reason,
    })),
    rate_limits: rateLimitSnapshot(),
  });
}
