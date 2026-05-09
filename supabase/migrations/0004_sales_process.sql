-- Aylek Sales — sales_process column on playbooks
-- Apply on top of 0003_playbook_expansion.sql via the Supabase SQL editor.

-- ────────────────────────────────────────────────────────────────────────────
-- Sales process: ordered list of stages with name, description, and the
-- responsible agent. Agents read from this jsonb to understand what stage
-- they're operating in and what comes next. Fully customisable per client.
--
-- Shape: [
--   { id: text, name: text, description: text, agent: text }
-- ]
-- ────────────────────────────────────────────────────────────────────────────

alter table public.playbooks
  add column if not exists sales_process jsonb not null default '[]'::jsonb;

-- Update the snapshot trigger function to include sales_process in the
-- "meaningful change" check so version history captures process edits.
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
    or new.sales_process is distinct from old.sales_process
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
