-- Aylek Sales — playbook expansion + per-lead approval status
-- Apply on top of 0002_playbooks_approvals.sql via the Supabase SQL editor.

-- ────────────────────────────────────────────────────────────────────────────
-- Playbook expansion: strategy, voice/tone, reply strategy, team members
-- ────────────────────────────────────────────────────────────────────────────

alter table public.playbooks
  add column if not exists strategy        jsonb not null default '{}'::jsonb,
  add column if not exists voice_tone      jsonb not null default '{}'::jsonb,
  add column if not exists reply_strategy  jsonb not null default '{}'::jsonb,
  add column if not exists team_members    jsonb not null default '[]'::jsonb;

-- Sequence steps gain an optional `sender_index` pointing into team_members[].
-- Stored inside the existing `sequences` jsonb so no schema change there.

-- Update the snapshot trigger function to include the new fields in the
-- "meaningful change" check.
create or replace function public.snapshot_playbook_version()
returns trigger language plpgsql as $$
declare
  meaningful boolean;
begin
  meaningful := (
    new.icp is distinct from old.icp
    or new.sequences is distinct from old.sequences
    or new.escalation_rules is distinct from old.escalation_rules
    or new.channel_flags is distinct from old.channel_flags
    or new.strategy is distinct from old.strategy
    or new.voice_tone is distinct from old.voice_tone
    or new.reply_strategy is distinct from old.reply_strategy
    or new.team_members is distinct from old.team_members
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

-- ────────────────────────────────────────────────────────────────────────────
-- Per-lead approval status
-- Operator-added leads (manual, import, inbound) default 'approved';
-- agent-sourced leads (ai_enriched, future automated sources) start as
-- 'pending_approval'. Application code sets it explicitly on insert.
-- ────────────────────────────────────────────────────────────────────────────

alter table public.leads
  add column if not exists approval_status text not null default 'approved'
    check (approval_status in ('pending_approval', 'approved', 'rejected'));

create index if not exists leads_approval_status_idx on public.leads(approval_status);
