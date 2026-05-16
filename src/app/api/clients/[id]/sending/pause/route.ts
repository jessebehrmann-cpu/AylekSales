import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { requireUser } from "@/lib/auth";
import { logEvent } from "@/lib/events";
import type { ClientEmailConfig, ClientEmailConfigStatus } from "@/lib/supabase/types";

export const dynamic = "force-dynamic";

const Body = z.object({
  action: z.enum(["pause", "resume"]),
});

/**
 * POST /api/clients/[id]/sending/pause
 *
 * Toggle the client's email_config.status between "paused" and the
 * underlying "verified"/"unverified" state. Used when HOS wants to
 * temporarily halt all outbound for a single client without tearing
 * down the verified domain.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: { id: string } },
): Promise<NextResponse> {
  const user = await requireUser();
  if (user.profile?.role !== "admin") {
    return new NextResponse("Admins only", { status: 403 });
  }
  const json = await req.json().catch(() => null);
  const parsed = Body.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json({ ok: false, error: "Invalid input" }, { status: 400 });
  }
  const supabase = createClient();
  const { data } = await supabase
    .from("clients")
    .select("email_config")
    .eq("id", params.id)
    .maybeSingle();
  const current = (data as { email_config?: ClientEmailConfig | null } | null)?.email_config ?? null;
  if (!current) {
    return NextResponse.json({ ok: false, error: "No email_config to toggle." }, { status: 400 });
  }
  let nextStatus: ClientEmailConfigStatus;
  if (parsed.data.action === "pause") {
    nextStatus = "paused";
  } else {
    nextStatus = current.verified_at ? "verified" : "unverified";
  }
  const next: ClientEmailConfig = { ...current, status: nextStatus };
  const { error } = await supabase
    .from("clients")
    .update({ email_config: next })
    .eq("id", params.id);
  if (error) {
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }
  await logEvent({
    event_type: "ai_action",
    client_id: params.id,
    user_id: user.auth.id,
    payload: { kind: "client_sending_status_changed", status: nextStatus },
  });
  return NextResponse.json({ ok: true, config: next });
}
