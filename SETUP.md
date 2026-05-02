# Aylek Sales — local setup

This is the foundation pass. The Next.js app boots and shows the route skeleton; the full
business logic (CSV import, AI sequence generation, Resend send loop, Stripe billing, etc.)
lands in subsequent passes per the build order in `prompt.md`.

## 1. Install

```sh
bun install      # or: npm install
```

## 2. Provision external services

You need accounts in five places. Create them yourself — none can be set up by Claude.

### Supabase
1. Create a project at https://supabase.com/dashboard.
2. Open the SQL editor and run the entire contents of `supabase/schema.sql` (one shot).
3. Auth → Providers → enable **Email**. (Optionally disable email confirmation while developing.)
4. Settings → API: copy the **Project URL**, **anon key**, and **service_role key** into `.env.local`.

### Anthropic
1. Create a key at https://console.anthropic.com/settings/keys.
2. Drop it into `ANTHROPIC_API_KEY`.
3. `ANTHROPIC_MODEL` defaults to `claude-sonnet-4-6` (latest Sonnet at time of writing — better
   quality + cost than the `claude-sonnet-4-20250514` listed in the original spec). Override if
   you want to pin a specific model.

### Resend
1. Add a domain at https://resend.com/domains and verify the DNS records.
2. Create an API key → `RESEND_API_KEY`.
3. Set `RESEND_FROM_EMAIL` to a `From:` address on your verified domain.
4. Inbound email + open/bounce tracking is wired through one webhook at
   `/api/webhooks/resend`. Configure it at https://resend.com/webhooks and copy the signing
   secret into `RESEND_WEBHOOK_SECRET`.

### Stripe
1. Get your secret + publishable keys from https://dashboard.stripe.com/apikeys.
2. Configure a webhook pointing at `/api/webhooks/stripe` (events: `invoice.payment_succeeded`,
   `invoice.payment_failed`, `customer.subscription.deleted`). Copy the signing secret into
   `STRIPE_WEBHOOK_SECRET`.

### Cron secret
```sh
openssl rand -hex 32
```
Put the result in `CRON_SECRET`. Vercel cron will hit `/api/cron/send-emails` hourly with
`Authorization: Bearer $CRON_SECRET`.

## 3. Local env

```sh
cp .env.example .env.local
# fill in every variable
```

## 4. Boot

```sh
bun dev          # → http://localhost:3000
```

Hit `/signup` to create your first user. After confirmation, sign in at `/login` and you'll
land on `/dashboard`. To grant yourself admin, run this in the Supabase SQL editor:

```sql
update public.users set role = 'admin' where email = 'you@example.com';
```

## 5. Deploy (Vercel)

1. Push the repo (already pointing at `github.com/jessebehrmann-cpu/AylekSales`).
2. Import into Vercel; framework preset auto-detects Next.js.
3. Paste every `.env.local` variable into Vercel's env settings (production + preview).
4. Update `NEXT_PUBLIC_APP_URL` to the deployed URL.
5. The cron in `vercel.json` runs hourly automatically.

## What's done in this pass

- Next.js 14 App Router + TypeScript + Tailwind + shadcn-style primitives
- Full route skeleton matching the spec
- Supabase schema + RLS policies (`supabase/schema.sql`)
- Supabase server / browser / middleware clients
- Auth scaffolding (login, signup, middleware redirects, role-aware via DB)
- Dashboard with real (DB-backed) stats + activity feed
- Lead / client / campaign / inbound / meeting list pages reading from the DB
- Webhook + cron route handlers (skeletons, signature verification TODO)
- Closed-loop helper at `src/lib/events.ts`

## What's left (per spec build order)

3. Client CRUD + Stripe customer/subscription provisioning
4. Manual lead create + stage update flow
5. CSV import + AI column mapping
6. Campaign builder (3-step wizard with Claude generation)
7. Email send loop + Resend webhook implementation
8. Inbound qualification (Claude) + auto-response
10. Activity feed payload-summarisation polish
11. Meeting create + complete flows
12. Quote send / accept / reject
13. Natural language query (`/query`) wiring
14. Stripe billing portal redirect + webhook implementation
15. Mobile sidebar drawer, toasts, skeletons, error boundaries
