import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { createClient, createServiceClient } from "@/lib/supabase/server";
import { requireUser } from "@/lib/auth";
import { logEvent } from "@/lib/events";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

const Body = z.object({
  email: z.string().email().max(200),
  full_name: z.string().trim().max(120).optional(),
});

/**
 * POST /api/clients/[id]/invite-owner
 *
 * Admin invites a client_owner for this client. We:
 *   1. Use the service-role Supabase admin API to invite the user by
 *      email (Supabase sends the magic-link). If the auth user already
 *      exists we reuse it.
 *   2. Upsert the public.users row with role='client_owner' and
 *      client_ids = [<this client>] (or merge if the user already has
 *      scopes on other clients).
 *
 * Returns the temp invite URL so HOS can copy it if Resend delivery is
 * delayed.
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
  const service = createServiceClient();

  // Confirm the client exists + admin has scope (RLS will also enforce)
  const { data: clientRow } = await supabase
    .from("clients")
    .select("id, name")
    .eq("id", params.id)
    .maybeSingle();
  if (!clientRow) return NextResponse.json({ ok: false, error: "Client not found" }, { status: 404 });
  const client = clientRow as { id: string; name: string };

  // 1. Invite via Supabase Admin API. If user already exists, reuse.
  let authUserId: string | null = null;
  let inviteLink: string | null = null;
  try {
    const redirectTo = `${process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000"}/portal`;
    // generateLink with type='invite' returns the magic link Supabase
    // would send. We surface it so the admin can copy it manually if
    // mail delivery is slow.
    const adminApi = (
      service as unknown as {
        auth: {
          admin: {
            createUser: (a: { email: string; user_metadata?: Record<string, unknown> }) => Promise<{
              data: { user: { id: string } | null };
              error: { message: string; status?: number } | null;
            }>;
            generateLink: (a: { type: string; email: string; options?: Record<string, unknown> }) => Promise<{
              data: { properties?: { action_link?: string; hashed_token?: string } };
              error: { message: string; status?: number } | null;
            }>;
          };
        };
      }
    ).auth.admin;

    const createRes = await adminApi.createUser({
      email: parsed.data.email,
      user_metadata: { invited_for_client: client.id, full_name: parsed.data.full_name },
    });
    if (createRes.error && !/already/i.test(createRes.error.message)) {
      return NextResponse.json(
        { ok: false, error: `Auth invite failed: ${createRes.error.message}` },
        { status: 500 },
      );
    }
    authUserId = createRes.data.user?.id ?? null;

    const linkRes = await adminApi.generateLink({
      type: "magiclink",
      email: parsed.data.email,
      options: { redirectTo },
    });
    if (linkRes.error) {
      console.warn("[invite-owner] generateLink error:", linkRes.error);
    } else {
      inviteLink = linkRes.data.properties?.action_link ?? null;
    }

    // generateLink returns the auth user too — fall back if createUser
    // failed because the user already existed.
    if (!authUserId) {
      const linkUser = (linkRes.data as { user?: { id: string } | null }).user;
      authUserId = linkUser?.id ?? null;
    }
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }

  if (!authUserId) {
    return NextResponse.json(
      { ok: false, error: "Couldn't resolve auth user id after invite." },
      { status: 500 },
    );
  }

  // 2. Upsert public.users with role + client_ids merge
  const { data: existingProfile } = await service
    .from("users")
    .select("client_ids, role")
    .eq("id", authUserId)
    .maybeSingle();
  const existing = existingProfile as { client_ids?: string[]; role?: string } | null;
  const merged = Array.from(new Set([...(existing?.client_ids ?? []), client.id]));
  const role = existing?.role === "admin" ? "admin" : "client_owner";

  const { error: profileErr } = await service
    .from("users")
    .upsert(
      {
        id: authUserId,
        email: parsed.data.email,
        full_name: parsed.data.full_name ?? null,
        role,
        client_ids: merged,
      },
      { onConflict: "id" },
    );
  if (profileErr) {
    return NextResponse.json(
      { ok: false, error: `Profile upsert failed: ${profileErr.message}` },
      { status: 500 },
    );
  }

  await logEvent({
    event_type: "ai_action",
    client_id: client.id,
    user_id: user.auth.id,
    payload: {
      kind: "client_owner_invited",
      client_name: client.name,
      invited_email: parsed.data.email,
      auth_user_id: authUserId,
      role,
    },
  });

  return NextResponse.json({
    ok: true,
    auth_user_id: authUserId,
    invite_link: inviteLink,
    client_scopes: merged,
    role,
  });
}
