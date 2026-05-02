import { createClient, createServiceClient } from "@/lib/supabase/server";
import type { EventType, Json } from "@/lib/supabase/types";

type LogEventArgs = {
  event_type: EventType;
  client_id?: string | null;
  lead_id?: string | null;
  campaign_id?: string | null;
  user_id?: string | null;
  payload?: Record<string, unknown>;
  /** Use the service-role client (for cron/webhook contexts where there is no user session). */
  service?: boolean;
};

/**
 * Append-only event log. Every meaningful action in the app calls this.
 * Payload should include human-readable names + before/after values so a
 * single event row tells the whole story without joining other tables.
 */
export async function logEvent(args: LogEventArgs) {
  const supabase = args.service ? createServiceClient() : createClient();
  const { error } = await supabase.from("events").insert({
    event_type: args.event_type,
    client_id: args.client_id ?? null,
    lead_id: args.lead_id ?? null,
    campaign_id: args.campaign_id ?? null,
    user_id: args.user_id ?? null,
    payload: (args.payload ?? {}) as Json,
  });
  if (error) {
    console.error("[events] failed to log", args.event_type, error);
  }
}
