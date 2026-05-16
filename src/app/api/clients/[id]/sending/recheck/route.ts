import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { requireUser } from "@/lib/auth";
import { logEvent } from "@/lib/events";
import { getDomain, verifyDomain, ResendDomainsError } from "@/lib/resend-domains";
import type { ClientEmailConfig } from "@/lib/supabase/types";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * POST /api/clients/[id]/sending/recheck
 *
 * Re-poll Resend for the domain's verification status + refresh the
 * stored DNS records. Flips email_config.status to "verified" on success.
 */
export async function POST(
  _req: NextRequest,
  { params }: { params: { id: string } },
): Promise<NextResponse> {
  const user = await requireUser();
  if (user.profile?.role !== "admin") {
    return new NextResponse("Admins only", { status: 403 });
  }
  const supabase = createClient();
  const { data } = await supabase
    .from("clients")
    .select("email_config")
    .eq("id", params.id)
    .maybeSingle();
  const current = (data as { email_config?: ClientEmailConfig | null } | null)?.email_config ?? null;
  if (!current?.resend_domain_id) {
    return NextResponse.json(
      { ok: false, error: "No Resend domain configured yet — create one first." },
      { status: 400 },
    );
  }
  try {
    // Ask Resend to re-verify (idempotent) then fetch the latest state.
    try {
      await verifyDomain(current.resend_domain_id);
    } catch (err) {
      // Verify can 400 if DNS isn't ready yet; we still fetch the domain
      // so the dashboard can show the current state. Don't fail the route.
      console.warn("[sending/recheck] verify call returned error:", err);
    }
    const fresh = await getDomain(current.resend_domain_id);
    const isVerified = fresh.status === "verified";
    const next: ClientEmailConfig = {
      ...current,
      status: isVerified ? "verified" : "unverified",
      verified_at: isVerified ? new Date().toISOString() : current.verified_at ?? null,
      dns_records: fresh.records ?? current.dns_records ?? [],
      last_error: null,
    };
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
      payload: {
        kind: isVerified ? "client_sending_verified" : "client_sending_recheck",
        resend_status: fresh.status,
      },
    });
    return NextResponse.json({ ok: true, config: next, resend_status: fresh.status });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const status = err instanceof ResendDomainsError ? err.status || 500 : 500;
    // Persist last_error so the admin page can show it.
    await supabase
      .from("clients")
      .update({
        email_config: { ...current, last_error: msg },
      })
      .eq("id", params.id);
    return NextResponse.json({ ok: false, error: msg }, { status });
  }
}
