-- Aylek Sales — add `reply_review` to the approvals.type check constraint.
--
-- Phase 3 of the production roadmap: inbound classifier now drafts a
-- reply (using the playbook's reply_strategy) and creates a
-- `reply_review` approval so HOS can edit + send rather than the
-- current "auto-send + log" path.
--
-- Apply on top of 0012_client_calendar_config.sql via the Supabase SQL
-- editor.

alter table public.approvals drop constraint if exists approvals_type_check;
alter table public.approvals add constraint approvals_type_check
  check (type in (
    'lead_list',
    'strategy_change',
    'human_stage_task',
    'proposal_review',
    'playbook_approval',
    'reply_review'
  ));
