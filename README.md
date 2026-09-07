# Organophile — Students & Payments Dashboard

Replaces the Replit tracker with a Next.js dashboard on top of Supabase,
fed by signed webhooks from **Kashier** (money) and **ukkera** (roster).

```
ukkera  ──POST (bearer token)──▶  ukkera-webhook  ─┐
                                                   ├─▶  raw event log ──▶ projections ──▶ dashboard
Kashier ──POST (HMAC signature)─▶ kashier-webhook ─┘
```

| Piece | Where | What it is |
|---|---|---|
| Database + RLS | `supabase/migrations/` | Postgres schema, projections, reporting views, policies |
| Webhook receivers | `supabase/functions/` | Deno Edge Functions, `verify_jwt = false`, own auth |
| Signature tests | `supabase/tests/` | Golden vectors generated from Kashier's own npm packages |
| Dashboard | `web/` | Next.js 16, App Router, Tailwind v4, bilingual AR/EN |

Supabase project: `egaaigoplqinjvwtnhoo` (eu-west-1)

## Getting started

```bash
# Edge Functions
cd supabase
deno task test        # signature + parsing tests
deno task check       # typecheck
deno task lint

# Dashboard
cd web
npm install
npm run dev
```

`web/.env.local` needs `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_ANON_KEY`.
Both are public by design — RLS is what protects the data. **The service role key
must never appear in `web/`.**

## Documentation

- [`docs/architecture.md`](docs/architecture.md) — how the data flows and why it is shaped this way
- [`docs/kashier-signature.md`](docs/kashier-signature.md) — the signature algorithm, exactly
- [`docs/runbook.md`](docs/runbook.md) — setup, cutover from Replit, and operations

## The two rules this system is built around

1. **Money only ever comes from a signature-verified Kashier webhook.**
   ukkera data is roster information; it never creates or changes a payment.
2. **Ingestion never throws.** A non-2xx reply makes Kashier retry for ~23.5
   hours, so a projection bug must not become a retry storm. Failures are
   recorded on the raw event and swept every 5 minutes.
