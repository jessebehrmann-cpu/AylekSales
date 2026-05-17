import { NextResponse, type NextRequest } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { runClose01Sweep } from "@/lib/agents/close-01";
import { logEvent } from "@/lib/events";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Item 8 — Close-01 cron. Runs every 4 hours (see vercel.json).
 *
 * One sweep over every actionable proposal:
 *  - sent + no view in 48h → send a nudge.
 *  - viewed + no accept in 5d → open a deal_cold approval.
 *
 * Auth: Bearer ${CRON_SECRET} via the standard Vercel cron header.
 */
export async function GET(req: NextRequest) {
  const auth = req.headers.get("authorization");
  if (process.env.CRON_SECRET && auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return new NextResponse("Unauthorized", { status: 401 });
  }
  const supabase = createServiceClient();
  const out = await runClose01Sweep(supabase);

  await logEvent({
    service: true,
    event_type: "ai_action",
    payload: {
      kind: "close01_cron_run",
      followups_sent: out.followups_sent,
      cold_flagged: out.cold_flagged,
    },
  });

  return NextResponse.json({ ok: true, ...out });
}
