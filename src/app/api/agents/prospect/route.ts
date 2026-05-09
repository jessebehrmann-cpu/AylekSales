import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { runProspect01 } from "@/lib/agents/prospect-01";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const Body = z.object({ client_id: z.string().uuid() });

/**
 * POST /api/agents/prospect
 *
 * Auth (either):
 *  - Authorization: Bearer ${CRON_SECRET}  (for scheduled / system runs)
 *  - Logged-in admin session via cookies   (for the "Run Prospect-01" button)
 */
export async function POST(req: NextRequest) {
  const auth = req.headers.get("authorization");
  const cronOk =
    process.env.CRON_SECRET && auth === `Bearer ${process.env.CRON_SECRET}`;

  let triggeredBy: string | null = null;
  if (!cronOk) {
    const supabase = createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      return new NextResponse("Unauthorized", { status: 401 });
    }
    const { data: profile } = await supabase
      .from("users")
      .select("role")
      .eq("id", user.id)
      .maybeSingle();
    if ((profile as { role?: string } | null)?.role !== "admin") {
      return new NextResponse("Admins only", { status: 403 });
    }
    triggeredBy = user.id;
  }

  const json = await req.json().catch(() => ({}));
  const parsed = Body.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json({ error: "client_id required" }, { status: 400 });
  }

  const result = await runProspect01(parsed.data.client_id, {
    triggeredBy: triggeredBy ?? undefined,
  });
  if (!result.ok) {
    return NextResponse.json(result, { status: result.config_error ? 400 : 500 });
  }
  return NextResponse.json(result);
}
