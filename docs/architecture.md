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

### Accepted linter warnings

Supabase's security linter flags three `SECURITY DEFINER` functions as callable
by `authenticated`:

| Function | Why it is exposed |
|---|---|
| `sweep_failed_events()` | Health page "Reprocess failed" button |
| `import_students(jsonb)` | Import page needs the same student-matching rule the webhook uses |
| `reconcile_transactions(jsonb)` | Import page comparison report (read-only) |

All three are **intentional** and each begins with an `app.is_admin()` check
that raises `forbidden` otherwise. A non-admin gets nothing and changes nothing;
`anon` cannot execute them at all. Verified by tests SEC8–SEC11.

## Scheduled jobs

| Job | Schedule | Purpose |
|---|---|---|
| `sweep-failed-webhook-events` | every 5 min | Reprocess `failed` raw events (max 12 attempts) |
| `purge-old-webhook-rejections` | daily 03:17 | Drop rejection records older than 90 days |

Raw event payloads are **never** purged — they are the audit trail for money.

## What the real payloads turned out to be

Both webhook shapes were captured from live "Test Webhook" fires, and both
differed from the documentation.

### Kashier transfers (was undocumented)

Recovered from `webhook_rejections.body_excerpt` — the endpoint refused the
delivery for having no signature, but still stored the body, so the shape was
learnable without ever trusting the request:

```json
{ "transferId": "TEST-TRS-0001", "amount": 100, "method": "wallet",
  "recipientName": "...", "recipientNumber": "01000000000",
  "merchantTransferId": "TEST-TRANSFER-0001", "status": "TRANSFERRED",
  "transferResponseCode": "00", "date": "2026-09-07T12:12:05.602Z",
  "signatureKeys": ["merchantTransferId","method","amount","merchantId","status"] }
```

The object is **flat** (no `data` wrapper) and the event value lives in
`status`, not `event`. Both are handled in migration 0009.

### ukkera (differs from the brief)

| Brief | Actual |
|---|---|
| `phone` | `student_phone` |
| `payment_date` | `date` |
| `course` | absent — **`package_name`** instead |
| `order_id` | absent — `transfer_id` instead |
| — | `student_email`, `event` |

This contradicts the brief's note that package data could not arrive by
webhook: it can, and migration 0010 populates `packages` from it. Every field
is read through a coalesce over **both** spellings, because the captured sample
is a synthetic `event: "test"` fire and a real payment may still use the
documented names. A payload with `event: "test"` is acknowledged and ignored
rather than inventing a student.

## Known gaps

- **`order_id == merchantOrderId` is unconfirmed.** Verify on the first real
  payment (see the runbook). Note ukkera's identifier arrives as `transfer_id`,
  so whether it equals Kashier's `merchantOrderId` is now an open question
  rather than a likely yes.
- **Transfer events may arrive unsigned.** Kashier signs the combined test
  envelope with the Transfer API key, and this account does not appear to have
  one — the fire arrived with no `x-kashier-signature` at all and was correctly
  refused. Registering transaction and transfer webhooks *separately* makes
  transaction events sign with the Payment API key; a Transfer API key must be
  requested from Kashier for transfer events to verify.
- **ukkera export column headers are unknown.** The import page auto-detects
  from a list of Arabic and English aliases and lets you remap by hand.
