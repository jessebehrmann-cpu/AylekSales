-- Aylek Sales — initial schema
-- Run this in the Supabase SQL editor on a fresh project.

create extension if not exists "pgcrypto";

-- ────────────────────────────────────────────────────────────────────────────
-- Tables
-- ────────────────────────────────────────────────────────────────────────────

create table if not exists public.clients (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  owner_name text,
  email text,
  phone text,
  suburb text,
  retainer_amount integer,
  revenue_share_pct numeric default 8,
  stripe_customer_id text,
  stripe_subscription_id text,
  status text default 'active' check (status in ('active','paused','churned')),
  notes text,
  created_at timestamptz default now()
);

create table if not exists public.users (
  id uuid primary key references auth.users(id) on delete cascade,
  full_name text,
  email text,
  role text default 'sales_user' check (role in ('admin','sales_user')),
  created_at timestamptz default now()
);

create table if not exists public.leads (
  id uuid primary key default gen_random_uuid(),
  client_id uuid references public.clients(id) on delete cascade,
  company_name text not null,
  contact_name text,
  title text,
  email text,
  phone text,
  suburb text,
  industry text,
  employees_estimate integer,
  website text,
  source text default 'import' check (source in ('import','manual','inbound','ai_enriched')),
  stage text default 'new' check (
    stage in ('new','contacted','replied','meeting_booked','quoted','won','lost','unsubscribed')
  ),
  contract_value numeric,
  assigned_to uuid references public.users(id) on delete set null,
  last_contacted_at timestamptz,
  notes text,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create index if not exists leads_client_id_idx on public.leads(client_id);
create index if not exists leads_stage_idx on public.leads(stage);
create index if not exists leads_email_idx on public.leads(lower(email));

create table if not exists public.campaigns (
  id uuid primary key default gen_random_uuid(),
  client_id uuid references public.clients(id) on delete cascade,
  name text not null,
  status text default 'draft' check (status in ('draft','active','paused','complete')),
  target_industry text,
  target_title text,
  sequence_steps jsonb,
  leads_enrolled integer default 0,
  created_by uuid references public.users(id) on delete set null,
  created_at timestamptz default now()
);

create index if not exists campaigns_client_id_idx on public.campaigns(client_id);

create table if not exists public.emails (
  id uuid primary key default gen_random_uuid(),
  client_id uuid references public.clients(id) on delete cascade,
  lead_id uuid references public.leads(id) on delete cascade,
  campaign_id uuid references public.campaigns(id) on delete set null,
  direction text default 'outbound' check (direction in ('outbound','inbound')),
  step_number integer,
  subject text,
  body text,
  status text default 'pending' check (
    status in ('pending','sent','opened','replied','bounced','failed')
  ),
  resend_message_id text,
  sent_at timestamptz,
  opened_at timestamptz,
  replied_at timestamptz,
  reply_body text,
  send_at timestamptz,
  created_at timestamptz default now()
);

create index if not exists emails_lead_id_idx on public.emails(lead_id);
create index if not exists emails_status_send_at_idx on public.emails(status, send_at);

create table if not exists public.meetings (
  id uuid primary key default gen_random_uuid(),
  client_id uuid references public.clients(id) on delete cascade,
  lead_id uuid references public.leads(id) on delete cascade,
  scheduled_at timestamptz,
  duration_minutes integer default 30,
  format text default 'video' check (format in ('video','phone','in_person')),
  status text default 'scheduled' check (status in ('scheduled','completed','no_show','cancelled')),
  notes text,
  created_at timestamptz default now()
);

create table if not exists public.quotes (
  id uuid primary key default gen_random_uuid(),
  client_id uuid references public.clients(id) on delete cascade,
  lead_id uuid references public.leads(id) on delete cascade,
  amount numeric,
  frequency text check (frequency in ('weekly','fortnightly','monthly')),
  scope text,
  status text default 'sent' check (status in ('sent','accepted','rejected','expired')),
  sent_at timestamptz,
  responded_at timestamptz,
  created_at timestamptz default now()
);

create table if not exists public.events (
  id uuid primary key default gen_random_uuid(),
  client_id uuid references public.clients(id) on delete cascade,
  lead_id uuid references public.leads(id) on delete cascade,
  campaign_id uuid references public.campaigns(id) on delete cascade,
  user_id uuid references public.users(id) on delete set null,
  event_type text not null,
  payload jsonb default '{}'::jsonb,
  created_at timestamptz default now()
);

create index if not exists events_created_at_idx on public.events(created_at desc);
create index if not exists events_client_created_idx on public.events(client_id, created_at desc);
create index if not exists events_lead_created_idx on public.events(lead_id, created_at desc);
create index if not exists events_event_type_idx on public.events(event_type);

create table if not exists public.queries (
  id uuid primary key default gen_random_uuid(),
  client_id uuid references public.clients(id) on delete cascade,
  user_id uuid references public.users(id) on delete set null,
  question text,
  generated_query text,
  result_summary text,
  created_at timestamptz default now()
);

-- ────────────────────────────────────────────────────────────────────────────
-- Triggers — keep leads.updated_at in sync, auto-create users row from auth
-- ────────────────────────────────────────────────────────────────────────────

create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists leads_touch_updated_at on public.leads;
create trigger leads_touch_updated_at
  before update on public.leads
  for each row execute function public.touch_updated_at();

create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.users (id, email, full_name, role)
  values (new.id, new.email, coalesce(new.raw_user_meta_data->>'full_name', new.email), 'sales_user')
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ────────────────────────────────────────────────────────────────────────────
-- Row Level Security
-- ────────────────────────────────────────────────────────────────────────────

alter table public.clients   enable row level security;
alter table public.users     enable row level security;
alter table public.leads     enable row level security;
alter table public.campaigns enable row level security;
alter table public.emails    enable row level security;
alter table public.meetings  enable row level security;
alter table public.quotes    enable row level security;
alter table public.events    enable row level security;
alter table public.queries   enable row level security;

create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.users where id = auth.uid() and role = 'admin'
  );
$$;

create or replace function public.is_authed() returns boolean
language sql stable as $$
  select auth.uid() is not null;
$$;

-- users: see your own row; admins see all; only admins can change roles
drop policy if exists users_select_self_or_admin on public.users;
create policy users_select_self_or_admin on public.users
  for select using (id = auth.uid() or public.is_admin());

drop policy if exists users_insert_self on public.users;
create policy users_insert_self on public.users
  for insert with check (id = auth.uid());

drop policy if exists users_update_self_or_admin on public.users;
create policy users_update_self_or_admin on public.users
  for update using (id = auth.uid() or public.is_admin());

-- clients: any authed user can read; only admins can write
drop policy if exists clients_select_authed on public.clients;
create policy clients_select_authed on public.clients
  for select using (public.is_authed());

drop policy if exists clients_admin_write on public.clients;
create policy clients_admin_write on public.clients
  for all using (public.is_admin()) with check (public.is_admin());

-- leads / campaigns / emails / meetings / quotes / events / queries:
-- any authed user can read + write (admin and sales_user). RLS still blocks anon.
do $$
declare t text;
begin
  foreach t in array array['leads','campaigns','emails','meetings','quotes','events','queries']
  loop
    execute format('drop policy if exists %1$I_authed_all on public.%1$I', t);
    execute format(
      'create policy %1$I_authed_all on public.%1$I for all using (public.is_authed()) with check (public.is_authed())',
      t
    );
  end loop;
end$$;
