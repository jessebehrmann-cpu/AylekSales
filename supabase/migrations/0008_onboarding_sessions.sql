-- Aylek Sales — onboarding interview sessions.
--
-- After a proposal_review is approved + sent (Resend), an onboarding_session
-- row is created with a unique token. The contact follows /onboard/[token]
-- (no auth) through a Claude-driven interview. Once complete, Claude
-- generates a draft playbook stored on the row. The contact reviews,
-- requests changes (each round saved to feedback_rounds), and ultimately
-- approves. Approval writes the playbook to public.playbooks with
-- status='pending_approval' and creates a `playbook_approval` for the HOS's
-- final sign-off.
--
-- Apply on top of 0007_approval_types.sql via the Supabase SQL editor.

create extension if not exists "pgcrypto";

create table if not exists public.onboarding_sessions (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients(id) on delete cascade,
  -- The lead (contact) who was emailed the link. Optional in case we want
  -- to send to a different contact later or migrate sessions across leads.
  lead_id uuid references public.leads(id) on delete set null,
  -- Public token used in the /onboard/[token] URL. Unique per session.
  token uuid not null default gen_random_uuid(),
  status text not null default 'pending' check (
    status in (
      'pending',          -- created, email queued
      'in_progress',      -- contact has loaded the page / answered questions
      'completed',        -- interview finished, no playbook yet
      'playbook_generated', -- Claude has generated a draft playbook
      'approved'          -- contact approved their playbook
    )
  ),
  -- {questions: [{topic, q, a}], notes?: string}
  answers jsonb not null default '{}'::jsonb,
  -- Generated playbook draft (mirrors public.playbooks shape).
  generated_playbook jsonb,
  -- [{requested_at, feedback, prior_playbook}, ...]
  feedback_rounds jsonb not null default '[]'::jsonb,
  sent_at timestamptz,
  completed_at timestamptz,
  approved_at timestamptz,
  created_by uuid references public.users(id) on delete set null,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create unique index if not exists onboarding_sessions_token_idx
  on public.onboarding_sessions(token);
create index if not exists onboarding_sessions_client_idx
  on public.onboarding_sessions(client_id);
create index if not exists onboarding_sessions_status_idx
  on public.onboarding_sessions(status);

-- Touch updated_at on every change (parallels playbooks pattern).
create or replace function public.touch_onboarding_sessions_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists onboarding_sessions_touch on public.onboarding_sessions;
create trigger onboarding_sessions_touch
  before update on public.onboarding_sessions
  for each row execute function public.touch_onboarding_sessions_updated_at();

-- Extend approval types: add `playbook_approval` for the HOS final sign-off
-- after the contact has approved their generated playbook.
alter table public.approvals drop constraint if exists approvals_type_check;
alter table public.approvals add constraint approvals_type_check
  check (type in (
    'lead_list',
    'strategy_change',
    'human_stage_task',
    'proposal_review',
    'playbook_approval'
  ));

-- RLS: the public /onboard/[token] route uses the service-role key from a
-- server route (no anon access ever). So we keep RLS off / restrictive on
-- this table — every read/write goes through createServiceClient on the
-- server. Mirrors the pattern used for approvals in this codebase.
alter table public.onboarding_sessions enable row level security;
-- (No policies on purpose: anon/authenticated can't touch this table from the
-- client. All access is server-side via service-role.)
