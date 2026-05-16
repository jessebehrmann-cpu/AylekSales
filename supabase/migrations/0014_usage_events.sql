-- Aylek Sales — per-client usage + cost tracking.
--
-- Every Apollo / Hunter / Anthropic / Resend call writes a row here.
-- The usage dashboard sums these per client per month + alerts when
-- a client passes 80% / 100% of their configured cap.
--
-- Apply on top of 0013_reply_review_approvals.sql via the SQL editor.

create table if not exists public.usage_events (
  id uuid primary key default gen_random_uuid(),
  client_id uuid references public.clients(id) on delete cascade,
  /** Provider + operation, e.g. "apollo.search", "apollo.bulk_match",
   *  "hunter.email_finder", "anthropic.messages", "resend.send". */
  kind text not null,
  /** Units consumed (Apollo credits, Hunter searches, Claude tokens,
   *  Resend sends — each provider has its own unit). */
  units integer not null default 1,
  /** Cost in cents (USD). 0 when the call is free (Apollo people
   *  search, Hunter 404, etc). */
  cost_cents integer not null default 0,
  payload jsonb,
  occurred_at timestamptz not null default now()
);

create index if not exists usage_events_client_kind_time_idx
  on public.usage_events(client_id, kind, occurred_at desc);
create index if not exists usage_events_time_idx
  on public.usage_events(occurred_at desc);

-- Per-client monthly cap in cents. NULL = no cap.
alter table public.clients
  add column if not exists usage_cap_cents jsonb;

comment on column public.clients.usage_cap_cents is
  'Per-provider monthly cap in cents, e.g. {"apollo": 10000, "anthropic": 50000}. Cron alerts on 80%/100%.';

-- RLS: usage_events client-scoped same as other tables.
alter table public.usage_events enable row level security;
drop policy if exists "client_scoped_usage_events" on public.usage_events;
create policy "client_scoped_usage_events" on public.usage_events
  for all
  using (
    public.is_admin()
    or (client_id is not null and public.has_client_scope(client_id))
  )
  with check (
    public.is_admin()
    or (client_id is not null and public.has_client_scope(client_id))
  );
