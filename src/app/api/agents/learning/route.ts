import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { runLearningAnalysis } from "@/lib/agents/learning";
import { createServiceClient } from "@/lib/supabase/server";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const Body = z.object({
  /** When omitted, runs analysis for every active client. */
  client_id: z.string().uuid().optional(),
});

/**
 * POST /api/agents/learning
 *
 * Auth (either):
 *  - Authorization: Bearer ${CRON_SECRET}  (for cron / system runs)
 *  - Logged-in admin session via cookies   (for manual triggering)
 *
 * Body: { client_id?: string }. When omitted, the analysis runs for every
 * active client.
 */
export async function POST(req: NextRequest) {
  const auth = req.headers.get("authorization");
  const cronOk =
    process.env.CRON_SECRET && auth === `Bearer ${process.env.CRON_SECRET}`;

  if (!cronOk) {
    const supabase = createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return new NextResponse("Unauthorized", { status: 401 });
    const { data: profile } = await supabase
      .from("users")
      .select("role")
      .eq("id", user.id)
      .maybeSingle();
    if ((profile as { role?: string } | null)?.role !== "admin") {
      return new NextResponse("Admins only", { status: 403 });
    }
  }

  const json = await req.json().catch(() => ({}));
  const parsed = Body.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  }

  let clientIds: string[] = [];
  if (parsed.data.client_id) {
    clientIds = [parsed.data.client_id];
  } else {
    // Pull every active client via service role so we don't miss any due to RLS
    const svc = createServiceClient();
    const { data: clients } = await svc
      .from("clients")
      .select("id")
      .eq("status", "active");
    clientIds = ((clients ?? []) as Array<{ id: string }>).map((c) => c.id);
  }

  const results = [];
  for (const id of clientIds) {
    results.push(await runLearningAnalysis(id));
  }
  return NextResponse.json({ ok: true, runs: results });
}

/** GET handler for cron hits — same logic, no body needed. */
export async function GET(req: NextRequest) {
  return POST(req);
}
