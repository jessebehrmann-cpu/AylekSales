-- Aylek Sales — extend approvals.type to include the per-stage task and the
-- post-meeting proposal-review approval kinds added by the lead-detail
-- redesign.
--
-- Apply on top of 0006_meeting_notes.sql via the Supabase SQL editor.

alter table public.approvals
  drop constraint if exists approvals_type_check;

alter table public.approvals
  add constraint approvals_type_check
  check (type in ('lead_list', 'strategy_change', 'human_stage_task', 'proposal_review'));
