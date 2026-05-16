-- Aylek Sales — per-client calendar booking config (Cal.com).
--
-- Schema additions:
--   - clients.calendar_config jsonb:
--       {
--         "provider": "cal_com",
--         "webhook_secret": "<svix-style secret>",
--         "team_member_links": [
--           { "team_member_id": "tm_1", "cal_link": "you/discovery-call", "event_type": "30min" }
--         ]
--       }
--   - meetings.cal_booking_id text — Cal.com's booking uid for idempotency.
--   - meetings.cal_booking_url text — direct link the contact can reschedule from.
--
-- Apply on top of 0011_rls_policies.sql via the Supabase SQL editor.

alter table public.clients
  add column if not exists calendar_config jsonb;

alter table public.meetings
  add column if not exists cal_booking_id text,
  add column if not exists cal_booking_url text;

create unique index if not exists meetings_cal_booking_id_idx
  on public.meetings(cal_booking_id)
  where cal_booking_id is not null;

comment on column public.clients.calendar_config is
  'Per-client calendar booking config: { provider: "cal_com", webhook_secret, team_member_links: [{team_member_id, cal_link, event_type}] }';
comment on column public.meetings.cal_booking_id is
  'Cal.com booking uid for idempotent webhook handling.';
