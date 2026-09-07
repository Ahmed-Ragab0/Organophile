# Architecture

## Data flow

```
                    signed HMAC                    bearer token
Kashier ─────────────────────────┐      ┌───────────────────────── ukkera
                                 ▼      ▼
                        kashier-webhook  ukkera-webhook      (Edge Functions,
                                 │      │                     verify_jwt=false)
                    verify ──────┤      ├────── verify
                                 ▼      ▼
                     kashier_events_raw  ukkera_events_raw   ← append-only,
                                 │      │                      deduped by body hash
                     project ────┤      ├────── project
                                 ▼      ▼
                    payments / payouts   students / courses / subscriptions
                                 └──────┬──────┘
                                        ▼
                              reporting views (RLS-scoped)
                                        ▼
                                  Next.js dashboard
```

## Why a raw log in front of everything

Each endpoint verifies, writes the exact body it received, replies 200, and
only then projects. That ordering buys three things:

- **A projection bug cannot lose a payment.** The payload is already durable.
  Fix the function, and the sweeper reprocesses the backlog automatically.
  This is not theoretical — it happened twice while building this system, and
  both times the delivery was recovered with no replay from Kashier.
- **Ingestion never throws.** `app.ingest_*` catches everything. Kashier treats
  a non-2xx as failure and retries for ~23.5 hours; a crash loop in a
  projection would otherwise turn one bad payload into a retry storm.
- **A real audit trail.** `raw_payload` is the evidence for every number the
  dashboard shows.

## Deduplication is by body hash, not by (transaction, event)

Kashier legitimately sends `pay`/`PENDING` and then `pay`/`SUCCESS` for the
same transaction. Keying dedupe on `(transaction_id, event)` would discard the
second one and freeze the payment as pending — a silent revenue bug.

A true retry is **byte-identical**, so `sha256(body)` deduplicates retries while
preserving genuine state transitions. Repeat deliveries bump `duplicate_count`
instead of creating a row, and the endpoint answers **409**, which Kashier
documents as success.

## Out-of-order deliveries cannot downgrade a payment

Deliveries are explicitly unordered. `app.status_rank()` gives each status a
monotonic rank and the upsert only moves a status forward, so a stale `PENDING`
arriving after `SUCCESS` is ignored. Same guard on `raw_payload`, so the stored
evidence always matches the stored status.

## The ukkera ↔ Kashier link is soft on purpose

The working hypothesis is `ukkera.order_id == kashier.merchantOrderId`.
**It is not verified yet.** So it is modelled as a normalised join plus a manual
override table, never as a foreign key:

- `subscriptions.order_key` and `payments.merchant_order_key` are generated
  columns, both `upper(btrim(...))`, so they cannot drift from their source.
- `v_payment_matches` prefers `payment_subscription_overrides` over the
  automatic join.
- Anything that fails to match surfaces in `v_unmatched_payments` /
  `v_unpaid_subscriptions` and can be linked by hand from the Reconciliation page.

A wrong foreign key would reject real payments at ingest time. A wrong soft
join just shows up in a report. **Confirm the hypothesis on the first live
payment** — check that `payments.merchant_order_id` equals the ukkera order id
for the same purchase.

## One place decides what money means

`app.signed_amount(event, status, amount)`:

- `pay` / `capture`, status `SUCCESS` → **+amount**
- `refund` / `reversal`, status `SUCCESS` → **−amount**
- `authorize` / `void` → **0** (an authorize only holds funds)
- any non-`SUCCESS` status → **0**

Every KPI, chart, and CSV export goes through it, so they cannot disagree.

## Security model

| Principal | Access |
|---|---|
| `anon` (browser, pre-login) | Nothing. Grants revoked, RLS forced. |
| `authenticated`, not in `admin_users` | Nothing. Every policy requires `app.is_admin()`. |
| `authenticated` admin | Read everything; write only students, courses, packages, subscriptions, expenses, overrides. |
| `service_role` (Edge Functions only) | The three ingest wrappers. Never leaves the function environment. |

- `payments`, `payouts`, and the raw logs are **read-only from the dashboard**.
  They change only through the signed webhook path.
- Views are `security_invoker = on`. Without it, a view owned by `postgres`
  would hand out rows that RLS on the base table forbids.
- Every function is `set search_path = ''` and fully schema-qualified, closing
  the search-path hijack that `SECURITY DEFINER` otherwise invites.
- The `app` schema is revoked from `public`, `anon`, and `authenticated`, and
  PostgREST only exposes `public` — so `app.*` is unreachable over HTTP.

`public.sweep_failed_events()` is intentionally callable by `authenticated`
(Supabase's linter flags this) because it checks `app.is_admin()` internally.
That guard is covered by a test.

## Scheduled jobs

| Job | Schedule | Purpose |
|---|---|---|
| `sweep-failed-webhook-events` | every 5 min | Reprocess `failed` raw events (max 12 attempts) |
| `purge-old-webhook-rejections` | daily 03:17 | Drop rejection records older than 90 days |

Raw event payloads are **never** purged — they are the audit trail for money.

## Known gaps

- **Transfer webhook payload shape is undocumented.** `project_kashier_transfer`
  probes several plausible field names and, if none match, fails *retryably*
  rather than discarding. Once the real shape is known, widen the extractor and
  the sweeper will reprocess everything that failed.
- **`order_id == merchantOrderId` is unconfirmed** (see above).
- **ukkera export column headers are unknown.** The import page auto-detects
  from a list of Arabic and English aliases and lets you remap by hand.
