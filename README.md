# Aylek Sales

AI-native fractional sales OS for commercial cleaning companies — inbound handling,
outbound sequences, pipeline CRM, and a queryable dashboard, all running closed-loop.

## Stack
Next.js 14 · TypeScript · Tailwind · Supabase (Postgres + RLS) · Anthropic Claude · Resend · Stripe · Vercel

## Get started
See [SETUP.md](SETUP.md) for environment provisioning and local boot instructions.

## Layout
- `src/app/(auth)` — login + signup
- `src/app/(dashboard)` — authed app: dashboard, clients, leads, campaigns, inbound, meetings, query, settings
- `src/app/api/webhooks` — Resend + Stripe inbound webhooks
- `src/app/api/cron/send-emails` — hourly send loop (Vercel cron)
- `src/lib/supabase` — server / browser / middleware Supabase clients + DB types
- `src/lib/{anthropic,resend,stripe,events}.ts` — third-party clients + closed-loop event logger
- `supabase/schema.sql` — database schema + RLS policies (run once on a fresh project)

The build is in progress. See `prompt.md` for the full spec and SETUP.md for what's
done vs. what's next.
