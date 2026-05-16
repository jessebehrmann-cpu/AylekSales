/**
 * Per-client outbound email config.
 *
 * Every Resend send site reads its `{ from, reply_to }` from this helper
 * rather than directly from env. When the client's email_config is
 * verified we use it; otherwise we fall back to the global RESEND_FROM_EMAIL
 * env var and log a `client_sending_unverified` event so HOS sees the
 * deliverability risk.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { logEvent } from "@/lib/events";
import type {
  ClientEmailConfig,
  ClientEmailConfigStatus,
  Database,
} from "@/lib/supabase/types";

type Supa = SupabaseClient<Database>;

export type EffectiveSendingConfig = {
  from: string;
  reply_to: string;
  /** "client" when the per-client verified config was used, "global"
   *  when we fell back to RESEND_FROM_EMAIL. */
  source: "client" | "global";
  /** The client's current status, when known. Useful for cron loops to
   *  decide whether to block the send entirely vs warn + send. */
  client_status: ClientEmailConfigStatus | null;
};

const GLOBAL_FROM = process.env.RESEND_FROM_EMAIL ?? "hello@aylek.sales";

/**
 * Look up the effective sending config for a given client. Always returns
 * a usable `{ from, reply_to }` — falls back to the global env when the
 * client has no config or isn't verified.
 *
 * For cron loops that need to BLOCK sends to unverified clients, check
 * `result.client_status` and skip when it's `"unverified"` or `"paused"`.
 */
export async function getClientSendingConfig(
  supabase: Supa,
  clientId: string | null,
): Promise<EffectiveSendingConfig> {
  if (!clientId) return { from: GLOBAL_FROM, reply_to: GLOBAL_FROM, source: "global", client_status: null };
  const { data } = await supabase
    .from("clients")
    .select("email_config")
    .eq("id", clientId)
    .maybeSingle();
  const cfg = (data as { email_config?: ClientEmailConfig | null } | null)?.email_config ?? null;

  if (cfg?.status === "verified" && cfg.from_email) {
    return {
      from: cfg.from_email,
      reply_to: cfg.reply_to || cfg.from_email,
      source: "client",
      client_status: cfg.status,
    };
  }
  return {
    from: GLOBAL_FROM,
    reply_to: GLOBAL_FROM,
    source: "global",
    client_status: cfg?.status ?? null,
  };
}

/**
 * Wrapper around getClientSendingConfig() that ALSO blocks the send when
 * the client has an explicit config that isn't verified yet. Use this in
 * cron loops where we'd rather log a clear error than silently leak from
 * the global address (e.g. sequence emails — those should always go from
 * the client's domain or wait).
 */
export async function getClientSendingConfigOrBlock(
  supabase: Supa,
  clientId: string,
): Promise<
  | { ok: true; config: EffectiveSendingConfig }
  | { ok: false; reason: string; client_status: ClientEmailConfigStatus | null }
> {
  const cfg = await getClientSendingConfig(supabase, clientId);
  if (cfg.client_status === "paused") {
    return { ok: false, reason: "client sending is paused", client_status: cfg.client_status };
  }
  if (cfg.client_status === "unverified") {
    await logEvent({
      service: true,
      event_type: "ai_action",
      client_id: clientId,
      payload: {
        kind: "client_sending_unverified",
        message: "Send blocked: client's per-client Resend domain isn't verified yet.",
      },
    });
    return { ok: false, reason: "client sending is not yet verified", client_status: cfg.client_status };
  }
  return { ok: true, config: cfg };
}
