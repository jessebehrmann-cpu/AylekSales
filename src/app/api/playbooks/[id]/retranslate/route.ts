import { NextResponse, type NextRequest } from "next/server";
import { createServiceClient } from "@/lib/supabase/server";
import { requireUser } from "@/lib/auth";
import { translateIcp } from "@/lib/icp-translator";
import { logEvent } from "@/lib/events";
import type { ICP, Playbook } from "@/lib/supabase/types";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * POST /api/playbooks/[id]/retranslate
 *
 * Force-regenerate the cached translated_params on a playbook. Used by
 * the Playbook editor's "Refresh ICP translation" button when HOS wants
 * to see Claude pick up an edit without waiting for the next
 * Prospect-01 run.
 *
 * Auth: admin only.
 */
export async function POST(
  _req: NextRequest,
  { params }: { params: { id: string } },
): Promise<NextResponse> {
  const user = await requireUser();
  if (user.profile?.role !== "admin") {
    return new NextResponse("Admins only", { status: 403 });
  }
  const supabase = createServiceClient();
  const { data: pbRow } = await supabase
    .from("playbooks")
    .select("id, icp, version, client_id")
    .eq("id", params.id)
    .maybeSingle();
  const pb = pbRow as Pick<Playbook, "id" | "icp" | "version" | "client_id"> | null;
  if (!pb) return NextResponse.json({ ok: false, error: "Playbook not found" }, { status: 404 });

  const icp = (pb.icp ?? {}) as ICP;
  // Strip the existing cache so we don't short-circuit.
  const { translated_params: _strip, ...icpNoCache } = icp;
  const translated = await translateIcp({ icp: icpNoCache, playbookVersion: pb.version });
  const nextIcp: ICP = { ...icp, translated_params: translated };
  const { error } = await supabase
    .from("playbooks")
    .update({ icp: nextIcp })
    .eq("id", pb.id);
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });

  await logEvent({
    service: true,
    event_type: "ai_action",
    client_id: pb.client_id,
    user_id: user.auth.id,
    payload: { kind: "icp_translation_refreshed", playbook_id: pb.id, version: pb.version },
  });

  return NextResponse.json({ ok: true, translated_params: translated });
}
