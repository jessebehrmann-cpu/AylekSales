-- Aylek Sales — market segment architecture.
--
-- Item 7 of the master brief. Adds the schema for per-playbook market
-- segments + per-segment run tracking + a new approval type so the
-- Segment Intelligence Loop (Learning-01, Item 9) can propose new
-- segments for HOS review.
--
-- Three additions, all back-compat:
--   1. playbooks.segments jsonb default '[]'  — the segment library
--      Claude produces during onboarding (≥ 8 segments per client). Each
--      segment has its own ICP + value_angle + status. Prospect-01 runs
--      per-segment, not against the playbook's catch-all ICP.
--   2. segment_runs table — one row per Prospect-01 invocation against a
--      specific segment. Powers pool-depletion math + Run N of M counter
--      + Learning-01's performance scoring.
--   3. approvals.type += 'segment_proposal' — Learning-01 generates these
--      when a segment is exhausted, scoring high, or 30+ days since last
--      proposal.
--
-- Apply on top of 0015_rls_service_bypass.sql via the Supabase SQL editor.

-- ── 1. Segment library on playbooks ──────────────────────────────────────
alter table public.playbooks
  add column if not exists segments jsonb not null default '[]'::jsonb;

comment on column public.playbooks.segments is
  'Per-playbook market segments. PlaybookSegment[] in TS. Each segment has
   its own ICP + value_angle + status (pending_approval | active | exhausted | rejected).
   Prospect-01 runs against active segments only.';

-- ── 2. Per-segment run tracking ──────────────────────────────────────────
create table if not exists public.segment_runs (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients(id) on delete cascade,
  playbook_id uuid not null references public.playbooks(id) on delete cascade,
  segment_id text not null,
  leads_sourced int not null default 0,
  leads_remaining int,
  performance_score numeric,
  ran_at timestamptz not null default now(),
  ran_by uuid references public.users(id) on delete set null
);

create index if not exists segment_runs_client_segment_idx
  on public.segment_runs(client_id, segment_id, ran_at desc);
create index if not exists segment_runs_playbook_idx
  on public.segment_runs(playbook_id, ran_at desc);

-- RLS — same pattern as 0011 (client-scoped) + 0015 (service_role bypass).
alter table public.segment_runs enable row level security;

drop policy if exists "client_scoped_segment_runs" on public.segment_runs;
create policy "client_scoped_segment_runs" on public.segment_runs
  for all
  using (
    public.is_admin()
    or (client_id is not null and public.has_client_scope(client_id))
  )
  with check (
    public.is_admin()
    or (client_id is not null and public.has_client_scope(client_id))
  );

drop policy if exists "service_role_bypass" on public.segment_runs;
create policy "service_role_bypass" on public.segment_runs
  for all
  using (
    auth.role() = 'service_role'
    or pg_has_role(current_user, 'postgres', 'member')
  )
  with check (
    auth.role() = 'service_role'
    or pg_has_role(current_user, 'postgres', 'member')
  );

-- ── 3. Extend approvals.type for segment_proposal ────────────────────────
alter table public.approvals drop constraint if exists approvals_type_check;
alter table public.approvals add constraint approvals_type_check
  check (type in (
    'lead_list',
    'strategy_change',
    'human_stage_task',
    'proposal_review',
    'playbook_approval',
    'reply_review',
    'segment_proposal'
  ));
