-- Aylek Sales — playbooks, version history, approvals + hard gate
-- Apply in the Supabase SQL editor on top of the existing schema.sql.

-- ────────────────────────────────────────────────────────────────────────────
-- Playbooks
-- ────────────────────────────────────────────────────────────────────────────

create table if not exists public.playbooks (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients(id) on delete cascade,
  version integer not null default 1,
  status text not null default 'draft' check (status in ('draft', 'pending_approval', 'approved')),
  -- ICP shape:
  --   { industries: text[], company_size: text, target_titles: text[],
  --     geography: text[], qualification_signal: text, disqualifiers: text[] }
  icp jsonb not null default '{}'::jsonb,
  -- Sequences shape: array of
  --   { step: int, subject: text, body: text, delay_days: int,
  --     branching_rules?: { on_open?: ..., on_no_reply?: ... } }
  sequences jsonb not null default '[]'::jsonb,
  -- Escalation rules:
  --   { after_step: int, action: 'pause'|'notify'|'handoff', notify_email?: text }
  escalation_rules jsonb not null default '[]'::jsonb,
  -- Channel toggles: { email: bool, phone: bool, linkedin: bool }
  channel_flags jsonb not null default '{"email": true, "phone": false, "linkedin": false}'::jsonb,
  notes text,
  created_by uuid references public.users(id) on delete set null,
  approved_by uuid references public.users(id) on delete set null,
  approved_at timestamptz,
  submitted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists playbooks_client_id_idx on public.playbooks(client_id);
create index if not exists playbooks_status_idx on public.playbooks(status);

-- One approved playbook per client at a time.
create unique index if not exists playbooks_one_approved_per_client_idx
  on public.playbooks(client_id) where status = 'approved';

-- ────────────────────────────────────────────────────────────────────────────
-- Playbook version history (snapshot every meaningful change)
-- ────────────────────────────────────────────────────────────────────────────

create table if not exists public.playbook_versions (
  id uuid primary key default gen_random_uuid(),
  playbook_id uuid not null references public.playbooks(id) on delete cascade,
  client_id uuid not null references public.clients(id) on delete cascade,
  version integer not null,
  status text not null,
  snapshot jsonb not null, -- full playbook row at the time of snapshot
  changed_by uuid references public.users(id) on delete set null,
  change_reason text,
  created_at timestamptz not null default now()
);

create index if not exists playbook_versions_playbook_id_idx
  on public.playbook_versions(playbook_id, version desc);

-- ────────────────────────────────────────────────────────────────────────────
-- Approvals queue
-- ────────────────────────────────────────────────────────────────────────────

create table if not exists public.approvals (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients(id) on delete cascade,
  type text not null check (type in ('lead_list', 'strategy_change')),
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  title text not null,
  summary text,
  -- payload shapes:
  --   lead_list:        { lead_ids: uuid[], campaign_id?: uuid, source: text }
  --   strategy_change:  { playbook_id: uuid, diff: { path: string, before: any, after: any }[],
  --                       reasoning: string, source: 'learning_agent' | 'hos' | ... }
  payload jsonb not null default '{}'::jsonb,
  related_playbook_id uuid references public.playbooks(id) on delete set null,
  related_campaign_id uuid references public.campaigns(id) on delete set null,
  created_by uuid references public.users(id) on delete set null,
  approved_by uuid references public.users(id) on delete set null,
  decided_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists approvals_client_status_idx on public.approvals(client_id, status);
create index if not exists approvals_status_created_idx on public.approvals(status, created_at desc);

-- ────────────────────────────────────────────────────────────────────────────
-- Triggers — touch updated_at, snapshot to version history
-- ────────────────────────────────────────────────────────────────────────────

drop trigger if exists playbooks_touch_updated_at on public.playbooks;
create trigger playbooks_touch_updated_at
  before update on public.playbooks
  for each row execute function public.touch_updated_at();

create or replace function public.snapshot_playbook_version()
returns trigger language plpgsql as $$
declare
  meaningful boolean;
begin
  -- only snapshot when something material changed (icp, sequences, escalation,
  -- channels, status, version, notes) — not every touch of updated_at
  meaningful := (
    new.icp is distinct from old.icp
    or new.sequences is distinct from old.sequences
    or new.escalation_rules is distinct from old.escalation_rules
    or new.channel_flags is distinct from old.channel_flags
    or new.status is distinct from old.status
    or new.version is distinct from old.version
    or coalesce(new.notes, '') is distinct from coalesce(old.notes, '')
  );
  if meaningful then
    insert into public.playbook_versions (
      playbook_id, client_id, version, status, snapshot, changed_by
    )
    values (
      new.id, new.client_id, new.version, new.status,
      to_jsonb(new),
      auth.uid()
    );
  end if;
  return new;
end;
$$;

drop trigger if exists playbooks_snapshot_on_update on public.playbooks;
create trigger playbooks_snapshot_on_update
  after update on public.playbooks
  for each row execute function public.snapshot_playbook_version();

drop trigger if exists playbooks_snapshot_on_insert on public.playbooks;
create or replace function public.snapshot_playbook_on_insert()
returns trigger language plpgsql as $$
begin
  insert into public.playbook_versions (
    playbook_id, client_id, version, status, snapshot, changed_by
  ) values (
    new.id, new.client_id, new.version, new.status, to_jsonb(new), auth.uid()
  );
  return new;
end;
$$;
create trigger playbooks_snapshot_on_insert
  after insert on public.playbooks
  for each row execute function public.snapshot_playbook_on_insert();

-- ────────────────────────────────────────────────────────────────────────────
-- HARD GATE — campaigns can only flip to 'active' if the client has an
-- approved playbook. Enforced at the database level so no code path can skip it.
-- ────────────────────────────────────────────────────────────────────────────

create or replace function public.campaigns_require_approved_playbook()
returns trigger language plpgsql as $$
begin
  if new.status = 'active' and (old.status is distinct from 'active' or tg_op = 'INSERT') then
    if not exists (
      select 1 from public.playbooks
      where client_id = new.client_id and status = 'approved'
    ) then
      raise exception 'Cannot activate campaign: client % has no approved playbook',
        new.client_id
        using errcode = 'check_violation';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists campaigns_gate_on_active on public.campaigns;
create trigger campaigns_gate_on_active
  before insert or update on public.campaigns
  for each row execute function public.campaigns_require_approved_playbook();

-- ────────────────────────────────────────────────────────────────────────────
-- RLS — same posture as other app tables (authed users r/w; admin enforcement
-- happens in application code).
-- ────────────────────────────────────────────────────────────────────────────

alter table public.playbooks         enable row level security;
alter table public.playbook_versions enable row level security;
alter table public.approvals         enable row level security;

do $$
declare t text;
begin
  foreach t in array array['playbooks', 'playbook_versions', 'approvals']
  loop
    execute format('drop policy if exists %1$I_authed_all on public.%1$I', t);
    execute format(
      'create policy %1$I_authed_all on public.%1$I for all using (public.is_authed()) with check (public.is_authed())',
      t
    );
  end loop;
end$$;
