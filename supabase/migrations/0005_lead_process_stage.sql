-- Aylek Sales — per-lead process stage pointer
-- Apply on top of 0004_sales_process.sql via the Supabase SQL editor.
--
-- Adds leads.process_stage_id — a soft pointer at the sales_process stage id
-- inside the lead's client's playbook. Drives the timeline view + manual
-- stage moves on the lead detail page. Soft FK only (the stage id lives in
-- jsonb on the playbook, not a separate table).

alter table public.leads
  add column if not exists process_stage_id text;

create index if not exists leads_process_stage_idx on public.leads(client_id, process_stage_id);
