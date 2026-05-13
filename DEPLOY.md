# Deploying Aylek Sales to Vercel

This is the production deploy guide. Local setup lives in [SETUP.md](./SETUP.md).

## 1. Push the repo

The repo is already at https://github.com/jessebehrmann-cpu/AylekSales. New
commits to `main` will auto-deploy once it's connected to a Vercel project.

## 2. Create the Vercel project

1. https://vercel.com/new → import `jessebehrmann-cpu/AylekSales`
2. **Framework preset:** Next.js (auto-detected)
3. **Root directory:** `./`
4. **Build command:** leave default (`next build`)
5. **Install command:** leave default — Vercel uses `npm ci` against the
   `package-lock.json`. (Bun is used locally; either works.)
6. **Output directory:** leave default

## 3. Environment variables

Paste each of these into **Project → Settings → Environment Variables** for
**Production**, **Preview**, and **Development** as appropriate.

### Required for the app to boot

| Variable | Where to get it | Notes |
|----------|-----------------|-------|
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase → Project → Settings → API | e.g. `https://qcbrojmwqxmcmxazojwp.supabase.co` |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | same page → "anon public" | Safe to expose, embedded in client JS |
| `SUPABASE_SERVICE_ROLE_KEY` | same page → "service_role" | **Server-only**, never `NEXT_PUBLIC_` |

### Required for outbound + inbound email

| Variable | Where to get it | Notes |
|----------|-----------------|-------|
| `RESEND_API_KEY` | https://resend.com/api-keys | |
| `RESEND_FROM_EMAIL` | a verified domain you own | e.g. `hello@aylek.sales` |
| `RESEND_WEBHOOK_SECRET` | https://resend.com/webhooks (Svix signing secret) | |

After deploy, set the webhook URL to `https://<your-vercel-domain>/api/webhooks/resend`.

### Required for AI features

| Variable | Where to get it | Notes |
|----------|-----------------|-------|
| `ANTHROPIC_API_KEY` | https://console.anthropic.com/settings/keys | Without this, sequence generation, inbound qualification, and the Learning Agent fall back to placeholder behaviour. |
| `ANTHROPIC_MODEL` | optional | Defaults to `claude-sonnet-4-6`. Override to pin a different model. |

### Required for Stripe billing

| Variable | Where to get it | Notes |
|----------|-----------------|-------|
| `STRIPE_SECRET_KEY` | https://dashboard.stripe.com/apikeys | Use `sk_test_…` for preview, `sk_live_…` for production |
| `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` | same page | |
| `STRIPE_WEBHOOK_SECRET` | https://dashboard.stripe.com/webhooks | After creating the webhook, copy the signing secret |

After deploy, point the Stripe webhook at
`https://<your-vercel-domain>/api/webhooks/stripe` and subscribe to:
`invoice.payment_succeeded`, `invoice.payment_failed`, `customer.subscription.deleted`.

### Required for Prospect-01 (lead sourcing)

Prospect-01 supports two providers. Set whichever you have access to — both is best (Apollo primary, Hunter as automatic fallback on 403 / 429 / 5xx).

| Variable | Where to get it | Notes |
|----------|-----------------|-------|
| `APOLLO_API_KEY` | https://app.apollo.io/ → Settings → Integrations → API | **Primary when set.** Industry/title-driven. Search endpoint requires the Basic plan or higher. Free: 50 exports/mo. Basic: 10,000/mo. |
| `APOLLO_BASE_URL` | optional | Defaults to `https://api.apollo.io` — only override if you're using a regional or sandbox endpoint. |
| `HUNTER_API_KEY` | https://hunter.io/api-keys | **Fallback when both are set; sole provider when only this is set.** Domain-driven — requires `icp.target_domains` on the playbook. Free: 25 searches/mo. |
| `HUNTER_BASE_URL` | optional | Defaults to `https://api.hunter.io`. |

Without either key the **Run Prospect-01** button is disabled and surfaces a clear "configure a provider" error. Diagnostic endpoint: `GET /api/agents/prospect-test` (admin-auth or `Authorization: Bearer ${CRON_SECRET}`) probes both providers — Apollo with a minimal search payload and Hunter with the zero-credit `/v2/account` endpoint — and returns the raw responses plus a fingerprint of each key actually being read at runtime.

### Required for crons + agent triggers

| Variable | How to generate | Notes |
|----------|-----------------|-------|
| `CRON_SECRET` | `openssl rand -hex 32` | Vercel sends this in the `Authorization: Bearer …` header to scheduled functions. Used by the send-emails cron, Prospect-01, and Learning Agent. |
| `NEXT_PUBLIC_APP_URL` | your Vercel domain | e.g. `https://aylek-sales.vercel.app` — used to construct fast-send-loop callback URLs after approvals |

## 4. Apply the database migrations

Open the Supabase SQL editor for the production project and run, in order:

1. `supabase/schema.sql`
2. `supabase/migrations/0002_playbooks_approvals.sql`
3. `supabase/migrations/0003_playbook_expansion.sql`
4. `supabase/migrations/0004_sales_process.sql`
5. `supabase/migrations/0005_lead_process_stage.sql`
6. `supabase/migrations/0006_meeting_notes.sql`
7. `supabase/migrations/0007_approval_types.sql`
8. `supabase/migrations/0008_onboarding_sessions.sql`

Each is idempotent (`create … if not exists`, `drop constraint if exists`,
etc.) so re-running on a partially-migrated DB is safe. The local dev
project at `qcbrojmwqxmcmxazojwp.supabase.co` already has all 8 applied;
only fresh production projects need this step.

## 5. Crons

Defined in [`vercel.json`](./vercel.json):

- `/api/cron/send-emails` — hourly. Picks up pending emails whose `send_at`
  has passed and sends them via Resend. Skips replied / unsubscribed leads
  and queues the next step.
- `/api/agents/learning` — daily at 06:00 UTC. Runs across every active
  client; for any sequence step underperforming benchmarks by >20%, creates
  a strategy_change approval with a Claude-generated subject proposal.

Vercel Hobby tier allows 2 cron jobs; Pro allows 40+. The send-emails cron
ALSO fires synchronously when a lead_list approval is approved, so first
emails go out within seconds rather than waiting for the next tick.

## 6. After first deploy

1. Sign in at `https://<your-domain>/signup`
2. Run this SQL to grant your account admin:
   ```sql
   update public.users set role = 'admin' where email = 'you@example.com';
   ```
3. Add a client at `/clients/new`
4. Build a playbook + submit for approval at `/playbooks`
5. Once the playbook is live, click **Run Prospect-01** on the client detail
   page to source your first leads (requires `APOLLO_API_KEY`).
6. Approve the lead_list in `/approvals` and watch the first emails go out.
