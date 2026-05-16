-- Aylek Sales — per-client sending domains.
--
-- Before: all outbound goes from a single RESEND_FROM_EMAIL env var.
-- After: each client owns a verified Resend sending domain, so replies
-- route to the right inbox and one client's deliverability doesn't sink
-- another's.
--
-- The shape:
--   email_config = {
--     "from_email": "hello@acme-sales.io",       -- the verified address we send AS
--     "reply_to":   "replies@acme-sales.io",     -- where replies route
--     "resend_domain_id": "<uuid from Resend>",  -- id returned by /domains
--     "status": "unverified" | "verified" | "paused",
--     "verified_at": "<iso>",                    -- set when status flips to verified
--     "dns_records": [...]                       -- DKIM/SPF/MX rows from Resend
--   }
--
-- Apply on top of 0008_onboarding_sessions.sql via the Supabase SQL editor.

alter table public.clients
  add column if not exists email_config jsonb;

-- Useful when fanning out a cron tick across clients — only send to those
-- with a verified domain. Index on a synthetic boolean expression.
create index if not exists clients_email_config_status_idx
  on public.clients ((email_config->>'status'));

comment on column public.clients.email_config is
  'Per-client Resend sending config: { from_email, reply_to, resend_domain_id, status, verified_at, dns_records }. NULL until set.';
