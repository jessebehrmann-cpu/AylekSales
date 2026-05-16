-- Aylek Sales — global suppression list.
--
-- Once an email lands here it can never be contacted again by ANY client.
-- Populated by:
--   - explicit unsubscribe replies (/u/[token])
--   - inbound webhook classifying a reply as "unsubscribe"
--   - Resend bounce / complaint webhooks
--   - manual admin add
--
-- Every outbound send path checks this list first.
--
-- Apply on top of 0009_client_email_config.sql via the Supabase SQL editor.

create extension if not exists "pgcrypto";

create table if not exists public.suppressed_emails (
  email text primary key,         -- always stored lowercase
  reason text not null check (reason in (
    'unsubscribe',
    'bounce',
    'complaint',
    'manual'
  )),
  /** When known — which lead first triggered the suppression. */
  source_lead_id uuid references public.leads(id) on delete set null,
  /** When known — which client the source lead belonged to. */
  source_client_id uuid references public.clients(id) on delete set null,
  /** Free-text — surfaced on /admin/suppressions for context. */
  notes text,
  /** Public token used in `/u/[token]` unsubscribe links. */
  unsubscribe_token uuid default gen_random_uuid(),
  suppressed_at timestamptz not null default now()
);

create index if not exists suppressed_emails_token_idx
  on public.suppressed_emails(unsubscribe_token);
create index if not exists suppressed_emails_source_client_idx
  on public.suppressed_emails(source_client_id);

comment on table public.suppressed_emails is
  'Global suppression list. Outbound paths check this before sending. Population: unsubscribe replies, bounces, complaints, manual.';
