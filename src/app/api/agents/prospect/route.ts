import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { runProspect01 } from "@/lib/agents/prospect-01";
import { apolloKeyFingerprint } from "@/lib/apollo";
import { hunterKeyFingerprint } from "@/lib/hunter";
import { resolveProviders } from "@/lib/agents/providers";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const Body = z.object({
  client_id: z.string().uuid(),
  segment_id: z.string().min(1).max(100).optional(),
});

/**
 * POST /api/agents/prospect
 *
 * Auth (either):
 *  - Authorization: Bearer ${CRON_SECRET}  (for scheduled / system runs)
 *  - Logged-in admin session via cookies   (for the "Run Prospect-01" button)
 */
export async function POST(req: NextRequest) {
  // Diagnostic: surface which provider keys are actually being read at
  // runtime + which one this run will use first. Makes 403 "free plan"
  // and "fell back to Hunter" trivial to root-cause from Vercel logs.
  const providers = resolveProviders();
  console.log(
    `[prospect] apollo=${apolloKeyFingerprint()} hunter=${hunterKeyFingerprint()} primary=${providers.primary} fallback=${providers.fallback}`,
  );

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
    segmentId: parsed.data.segment_id,
  });
  if (!result.ok) {
    return NextResponse.json(result, { status: result.config_error ? 400 : 500 });
  }
  return NextResponse.json(result);
}
