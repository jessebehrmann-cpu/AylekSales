-- Aylek Sales — Row-Level Security across every client-scoped table.
--
-- Goal: when a non-admin user authenticates via Supabase, they can ONLY
-- see/touch rows for the clients listed in users.client_ids. Admin users
-- still see everything. Service role bypasses RLS automatically (cron +
-- webhooks + agent code paths keep working unchanged).
--
-- Schema additions:
--   - public.users.client_ids uuid[] — list of client_id scopes for
--     non-admin users. Admins get the global view regardless.
--
-- Policy strategy (per client-scoped table):
--   - ENABLE RLS
--   - One PERMISSIVE policy `client_scoped_<table>` covering ALL
--     operations (SELECT/INSERT/UPDATE/DELETE) with predicate:
--       admin? OR row.client_id ∈ user.client_ids
--   - Service role bypasses RLS, so cron + agents are unaffected.
--
-- Apply on top of 0010_suppression_list.sql via the Supabase SQL editor.

-- ── users.client_ids column ──────────────────────────────────────────────
alter table public.users
  add column if not exists client_ids uuid[] not null default '{}';

comment on column public.users.client_ids is
  'Per-user client scopes for RLS. Empty for admins (who see everything). Populated for client_owner / sales_user roles.';

-- Extend users.role check constraint to allow the new "client_owner" role
-- introduced in Phase 5.
alter table public.users drop constraint if exists users_role_check;
alter table public.users add constraint users_role_check
  check (role in ('admin', 'sales_user', 'client_owner'));

-- ── reusable predicate helpers ───────────────────────────────────────────
-- Returns true when the caller is an admin (per public.users).
create or replace function public.is_admin() returns boolean
  language sql stable security definer
  set search_path = public
  as $$
    select exists (
      select 1 from public.users
      where users.id = auth.uid() and users.role = 'admin'
    );
  $$;

-- Returns true when the caller has the given client_id in their scope.
create or replace function public.has_client_scope(target uuid)
  returns boolean
  language sql stable security definer
  set search_path = public
  as $$
    select exists (
      select 1 from public.users
      where users.id = auth.uid()
        and (users.role = 'admin' or users.client_ids @> array[target])
    );
  $$;

grant execute on function public.is_admin() to authenticated, anon;
grant execute on function public.has_client_scope(uuid) to authenticated, anon;

-- ── users: self-row visibility (signup writes a row for the new user) ────
alter table public.users enable row level security;

drop policy if exists "users_self_select" on public.users;
create policy "users_self_select" on public.users
  for select using (
    auth.uid() = id or public.is_admin()
  );

drop policy if exists "users_self_insert" on public.users;
create policy "users_self_insert" on public.users
  for insert with check (auth.uid() = id);

drop policy if exists "users_admin_update" on public.users;
create policy "users_admin_update" on public.users
  for update using (public.is_admin()) with check (public.is_admin());

-- ── clients: a user sees clients they're scoped to (or all if admin) ─────
alter table public.clients enable row level security;
drop policy if exists "clients_scoped" on public.clients;
create policy "clients_scoped" on public.clients
  for all using (public.has_client_scope(id))
  with check (public.has_client_scope(id));

-- ── client-scoped tables: one policy each, all operations ────────────────
do $$
declare
  t text;
  tables text[] := array[
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
    'onboarding_sessions'
  ];
begin
  foreach t in array tables loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists "client_scoped_%I" on public.%I', t, t);
    execute format(
      'create policy "client_scoped_%I" on public.%I
         for all
         using (
           public.is_admin()
           or (
             client_id is not null
             and public.has_client_scope(client_id)
           )
         )
         with check (
           public.is_admin()
           or (
             client_id is not null
             and public.has_client_scope(client_id)
           )
         )',
      t, t
    );
  end loop;
end$$;

-- ── suppressed_emails: read for authenticated, write via service role ───
alter table public.suppressed_emails enable row level security;
drop policy if exists "suppressed_read" on public.suppressed_emails;
create policy "suppressed_read" on public.suppressed_emails
  for select using (auth.role() = 'authenticated' or public.is_admin());
-- No INSERT/UPDATE/DELETE policies — only service role can mutate.

-- ── Sanity: backfill empty client_ids on existing users + grant admin
-- everywhere by default so the current dashboard keeps working until
-- per-client owners are introduced in Phase 5.
update public.users
  set client_ids = '{}'
  where client_ids is null;
