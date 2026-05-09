-- Aylek Sales — meeting notes captured at the end of every Have-Meeting stage.
-- Apply on top of 0005_lead_process_stage.sql via the Supabase SQL editor.

create table if not exists public.meeting_notes (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid not null references public.leads(id) on delete cascade,
  client_id uuid references public.clients(id) on delete set null,
  outcome text not null check (outcome in ('positive', 'neutral', 'negative', 'no_show')),
  notes text,
  transcript text,
  objections text,
  next_steps text,
  /** The follow-up proposal email Claude drafted after the meeting.
   *  Stored alongside the notes so the approval card can render it. */
  drafted_proposal_subject text,
  drafted_proposal_body text,
  /** Optional: the strategy_change approval that wraps the drafted proposal
   *  for HOS review. NULL when the agent skipped drafting (no API key etc). */
  related_approval_id uuid references public.approvals(id) on delete set null,
  created_by uuid references public.users(id) on delete set null,
  created_at timestamptz not null default now()
);

create index if not exists meeting_notes_lead_id_idx on public.meeting_notes(lead_id);
create index if not exists meeting_notes_client_id_idx on public.meeting_notes(client_id);

-- ────────────────────────────────────────────────────────────────────────────
-- RLS — same pattern as the other operator tables
-- ────────────────────────────────────────────────────────────────────────────

alter table public.meeting_notes enable row level security;

drop policy if exists meeting_notes_authed_all on public.meeting_notes;
create policy meeting_notes_authed_all on public.meeting_notes
  for all using (public.is_authed()) with check (public.is_authed());
