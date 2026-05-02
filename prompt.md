# Aylek Sales — Claude Code Build Prompt
## Full AI-Native Fractional Sales System for Commercial Cleaning Companies

---

## WHAT YOU ARE BUILDING

**Aylek Sales** — an AI-native fractional sales operating system that runs the entire sales function for commercial cleaning companies as an outsourced service.

The primary user is **the head of sales operator** (Jesse) managing the system across multiple cleaning company clients. Some internal team members may also log in.

The system does four things:
1. **Inbound handling** — AI answers and qualifies inbound leads via email and web form, responds instantly, books meetings, logs everything
2. **Outbound sequences** — AI builds and executes multi-step cold email campaigns targeting Facilities Managers, Office Managers, and Property Managers at Sydney businesses
3. **Pipeline CRM** — full lead lifecycle from first touch to signed contract, every action logged
4. **Queryable dashboard** — natural language interface to interrogate the entire pipeline ("what's our reply rate this month?" "which suburb converts best?")

Everything is closed-loop. Every action, email, reply, stage change, and query is a structured event in the database. The company is queryable by design from day one.

---

## TECH STACK

- **Framework:** Next.js 14 (App Router)
- **Database:** Supabase (Postgres + RLS)
- **Auth:** Supabase Auth (roles: admin, sales_user)
- **AI:** Anthropic Claude API (`claude-sonnet-4-20250514`)
- **Email sending + inbound:** Resend
- **Payments:** Stripe (recurring retainer billing per client)
- **Deployment:** Vercel
- **Styling:** Tailwind CSS + shadcn/ui

---

## BUILD ORDER

1. Supabase — tables, RLS policies, seed data
2. Auth — login/signup, role redirect, protected routes
3. Client CRUD
4. Lead management — list, detail, manual create, stage updates
5. CSV import — upload, AI column mapping, preview, confirm
6. Campaign builder — wizard, AI generation, enrolment
7. Email sending — Resend, cron job, webhooks
8. Inbound handling — webhook, AI qualification, auto-response
9. Event logging — verify every action above logs correctly
10. Dashboard — stats + activity feed from events
11. Meeting management
12. Quote tracking
13. Natural language query
14. Stripe billing
15. Polish — loading states, empty states, mobile, errors

---

## SUCCESS CRITERIA

- New client onboarded in under 3 minutes
- 200 leads imported via CSV in under 5 minutes with AI column mapping
- 3-email sequence generated in under 30 seconds
- First emails sent within 1 hour of campaign launch
- Inbound email → AI qualifies + auto-responds within 60 seconds
- Every action visible in lead event timeline
- "What's our best performing campaign this month?" returns accurate answer
- System runs autonomously overnight with zero human input

---

The full original spec (database schema, route map, AI prompts, design system) lives in
the conversation transcript that produced this scaffold. Foundation pass complete; see
SETUP.md for the running list of what's done vs. what's next.
