import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { requireUser } from "@/lib/auth";
import { logEvent } from "@/lib/events";
import { createDomain, ResendDomainsError } from "@/lib/resend-domains";
import type { ClientEmailConfig } from "@/lib/supabase/types";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

const Body = z.object({
  domain: z.string().trim().min(3).max(120),
  from_local: z.string().trim().min(1).max(64).default("hello"),
  reply_to_local: z.string().trim().min(1).max(64).default("replies"),
});

/**
 * POST /api/clients/[id]/sending/verify
 *
 * Admin form action: create a Resend domain for the client and persist the
 * DKIM/SPF records on `clients.email_config`. The admin then pastes
 * those records into DNS and clicks Recheck.
 *
 * Auth: logged-in admin only.
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
  try {
    const created = await createDomain(parsed.data.domain);
    const fromEmail = `${parsed.data.from_local}@${parsed.data.domain}`;
    const replyTo = `${parsed.data.reply_to_local}@${parsed.data.domain}`;
    const config: ClientEmailConfig = {
      from_email: fromEmail,
      reply_to: replyTo,
      resend_domain_id: created.id,
      status: "unverified",
      verified_at: null,
      dns_records: created.records ?? [],
      last_error: null,
    };
    const { error } = await supabase
      .from("clients")
      .update({ email_config: config })
      .eq("id", params.id);
    if (error) {
      return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
    }
    await logEvent({
      event_type: "ai_action",
      client_id: params.id,
      user_id: user.auth.id,
      payload: {
        kind: "client_sending_domain_created",
        domain: parsed.data.domain,
        resend_domain_id: created.id,
      },
    });
    return NextResponse.json({ ok: true, config });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const status = err instanceof ResendDomainsError ? err.status || 500 : 500;
    return NextResponse.json({ ok: false, error: msg }, { status });
  }
}
