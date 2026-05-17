-- Aylek Sales — service-role / superuser bypass for every RLS-enabled table.
--
-- Phase 4's RLS policies (0011) gate on `public.is_admin()` which reads
-- public.users. That works for browser sessions where auth.uid() is set,
-- but silently denies in two important contexts:
--   1. Supabase SQL editor as superuser (auth.uid() is null → is_admin
--      returns false → write blocked with no error, "Success. No rows
--      returned").
--   2. Service-role API calls that don't end up in the SECURITY DEFINER
--      bypass path automatically (rare today since createServiceClient()
--      uses the service role JWT directly, but defence in depth).
--
-- Fix: add one extra permissive policy per table that allows the row
-- when EITHER the caller is the Postgres superuser OR the request is
-- using the service_role JWT. Existing policies stay in place — these
-- are ORed in, so the union widens.
--
-- Apply on top of 0014_usage_events.sql via the Supabase SQL editor.

do $$
declare
  t text;
  tables text[] := array[
    'clients',
    'users',
    'leads',
    'campaigns',
    'emails',
    'meetings',
    'quotes',
    'events',
    'queries',
    'playbooks',
    'playbook_versions',
    'approvals',
    'meeting_notes',
    'onboarding_sessions',
    'suppressed_emails',
    'usage_events'
  ];
begin
  foreach t in array tables loop
    -- Only act if the table actually exists (skip cleanly when run
    -- against a database that's missing later-migration tables).
    if to_regclass(format('public.%I', t)) is not null then
      execute format('alter table public.%I enable row level security', t);
      execute format('drop policy if exists "service_role_bypass" on public.%I', t);
      execute format(
        'create policy "service_role_bypass" on public.%I
           for all
           using (
             auth.role() = ''service_role''
             or pg_has_role(current_user, ''postgres'', ''member'')
           )
           with check (
             auth.role() = ''service_role''
             or pg_has_role(current_user, ''postgres'', ''member'')
           )',
        t
      );
    end if;
  end loop;
end$$;
