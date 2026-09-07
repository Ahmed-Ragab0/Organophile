# PROJECT.md — Organophile

**Read this first in a new session.** It is the single place that carries context
between conversations. Update it whenever something structural changes.

For what the product actually *does* — every page, its data source and what is
wired to what — read [`docs/FEATURES.md`](docs/FEATURES.md) next.

Last updated: 2026-09-08

---

## 1. What this is

A students-and-money console for an Egyptian organic-chemistry tutoring
business. It replaces a Replit tracker.

Money arrives through **Kashier** (the payment gateway). Student and course
information arrives through **ukkera** (the LMS the courses are sold on).
Both push webhooks; the system verifies, stores, and reconciles them, and
presents one financial picture.

The chain that must always work:

```
Kashier → webhook → payment → student → course → wallet → ledger → dashboard
```

| Piece | Where |
|---|---|
| Database, RLS, all business logic | `supabase/migrations/` |
| Webhook + sync endpoints (Deno) | `supabase/functions/` |
| Signature tests (golden vectors) | `supabase/tests/` |
| Dashboard (Next.js 16, React 19, Tailwind v4) | `web/` |
| Design skills installed for this repo | `.claude/skills/` |

- Supabase project: **`egaaigoplqinjvwtnhoo`** (eu-west-1)
- Base URL: `https://egaaigoplqinjvwtnhoo.supabase.co`
- Kashier merchant: **MID-48090-321**
- Owner / only admin: `ahmed@gmail.com`

---

## 2. Run it

```bash
# dashboard
cd web && npm install && npm run dev      # http://localhost:3000

# edge functions
cd supabase
deno task test     # 72 tests
deno task check
deno task lint
```

`web/.env.local` needs `NEXT_PUBLIC_SUPABASE_URL` and
`NEXT_PUBLIC_SUPABASE_ANON_KEY`. Both are public by design — RLS protects the
data. **The service role key must never appear in `web/`.**

---

## 3. The rules this system is built on

These are not style preferences. Breaking one causes a real, specific bug.

1. **Money only ever comes from a signature-verified Kashier webhook** (or a
   deliberate manual ledger entry). ukkera data is roster information; it never
   creates or changes money.
2. **Ingestion never throws.** A non-2xx makes Kashier retry for ~23.5 hours, so
   a projection bug must not become a retry storm. Failures are recorded on the
   raw event and swept every 5 minutes.
3. **Dedupe hashes the request body**, not `(transaction_id, event)`. Kashier
   legitimately sends `pay`/PENDING then `pay`/SUCCESS for one transaction;
   keying on the pair would discard the second and freeze the payment as pending.
4. **Deliveries are unordered.** `status_rank` / `transfer_rank` mean a status
   can only move forward, so a late PENDING cannot undo a SUCCESS.
5. **A payment and its wallet movement are written in the same transaction.**
   `sync_payment_to_ledger` is called from inside the projection.
6. **Nothing financial is deleted** — only voided. Voiding one half of a
   transfer voids both.
7. **Test-mode traffic is excluded from every money figure**, balances
   included. The invariant that proves it:
   `sum(wallet balances) = opening balances + revenue − expenses`.
   There are **two** independent test signals and either is enough:
   `mode = 'test'` (which endpoint it arrived on) and `is_test_webhook`
   (Kashier's own flag). The dashboard's **Test** button posts to whichever URL
   it is aimed at, live included, so honouring only the first booked a
   synthetic 100 EGP as real revenue — fixed in `0017`.
8. **Direct writes to `ledger_entries` are denied by RLS.** Everything goes
   through `add_expense`, `add_manual_revenue`, `transfer_between_wallets`,
   `void_ledger_entry`.

---

## 4. Data model, briefly

**Ingest (append-only)**
- `kashier_events_raw`, `ukkera_events_raw` — every delivery, deduped by
  `body_sha256`, with `state` (pending/processed/failed/ignored).
- `webhook_rejections` — anything refused, with a 2 KB body excerpt. This is how
  two undocumented payload shapes were recovered without trusting the request.

**Domain**
- `students`, `universities`, `courses`, `packages`, `subscriptions`
- `payments` (Kashier transactions), `payouts` (Kashier transfers),
  `kashier_account` (balance from the API)

**Money**
- `subscription_installments` — the collection *plan* for a subscription: what
  is expected and when. It moves no money; what was actually received is in
  `ledger_entries`. Edited on the Pricing page.
- `wallets` — the six real accounts. One is flagged `is_kashier_default`; that
  is where Kashier revenue lands.
- `ledger_entries` — the single source of truth. `amount` is always positive;
  direction comes from `entry_type`.

**Key views**
`v_money_position` (where the money is, per mode), `v_order_journey` (ordered →
paid → banked, one row per order), `v_payment_payout_status` (FIFO payout
estimate), `v_revenue_by_method`, `v_fees_monthly`, `v_payouts_monthly`,
`v_dashboard_kpis`, `v_wallet_balances`, `v_ledger`, `v_finance_daily`,
`v_finance_monthly`, `v_monthly_report`, `v_student_financials`,
`v_subscription_financials`, `v_course_catalogue`, `v_revenue_by_course`,
`v_revenue_by_university`, `v_expenses_by_category`, `v_payments_enriched`,
`v_unmatched_payments`, `v_unpaid_subscriptions`, `v_ingest_health`

**Functions the app calls**
`add_expense`, `add_manual_revenue`, `transfer_between_wallets`,
`void_ledger_entry`, `search_students`, `import_students`,
`reconcile_transactions`, `sweep_failed_events`, `normalize_phone`

`search_students` is the **only** SECURITY INVOKER routine, deliberately: it
returns student rows, and INVOKER is what keeps RLS applying to the caller. It
therefore may not name anything in schema `app` — `authenticated` has no USAGE
there, and schema USAGE is checked when a name is resolved, so a single
cross-schema call fails the query while it is still being planned, filters or
not. `public.normalize_phone` is the DEFINER wrapper that exists for this.

---

## 5. Endpoints

| Purpose | URL |
|---|---|
| Kashier transactions (test) | `…/functions/v1/kashier-webhook?mode=test` |
| Kashier transactions (live) | `…/functions/v1/kashier-webhook?mode=live` |
| ukkera | `…/functions/v1/ukkera-webhook` |
| Payout sync (POST, admin or service key) | `…/functions/v1/kashier-sync-payouts?mode=live` |

`kashier-sync-payouts` is the only function a browser calls, so it is the only
one with CORS. Origins are reflected from an allowlist — localhost plus
`DASHBOARD_ORIGINS` — never `*`, because the request carries an admin's bearer
token.

All deployed with `verify_jwt = false` — Supabase's JWT check would accept the
public anon key, so each function authorises its caller itself (HMAC signature,
bearer token, or admin JWT / service key).

### Secrets (Supabase → Edge Functions → Secrets)

| Name | Notes |
|---|---|
| `KASHIER_PAYMENT_API_KEY_LIVE` | **Comma-separated list.** This account has two live Payment API keys (`Default-Live-Key` and one named `يوكيرا`); Kashier signs with whichever created the order. |
| `KASHIER_PAYMENT_API_KEY_TEST` | Same, test mode |
| `KASHIER_TRANSFER_API_KEY_LIVE/TEST` | For transfer webhook signatures (see open issues) |
| `KASHIER_SECRET_KEY_LIVE/TEST` | Merchant Secret Key, for the Payout REST API |
| `UKKERA_WEBHOOK_TOKEN` | Value is in `.secrets/SETUP-SECRETS.md` (gitignored) |
| `DASHBOARD_ORIGINS` | Comma-separated origins allowed to call `kashier-sync-payouts` from a browser. localhost is always allowed; set this to the Vercel URL. |

`KASHIER_ALLOW_UNVERIFIED` exists but **must stay unset**.

---

## 6. Hard-won facts about the two upstreams

Both differ from their documentation. These were established from real traffic,
not from reading.

### Kashier signature

Header `x-kashier-signature`, HMAC-SHA256 hex over a canonical string built from
`signatureKeys`. The security of the endpoint depends on reproducing
`query-string@7.stringify` **byte for byte**:

| Rule | Correct |
|---|---|
| Key order | `Array#sort()` — UTF-16 code units, so `Banana` < `Zebra` < `apple` |
| Space | `%20`, never `+` |
| `! ' ( ) *` | escaped |
| `~ . - _` | not escaped |
| `null` | bare key, no `=` |
| Missing key | dropped entirely |

Golden vectors in `supabase/tests/` are generated from the real npm packages
(`query-string@7.1.3`, `underscore@1.13.6`) — regenerate with
`node supabase/tests/generate-vectors.js`. **Verified working against real
signed Kashier traffic.**

### Kashier transfers

- Payload is **flat** — no `data` wrapper — and the state is in `status`, not
  `event`.
- Real states include **`IN_TRANSIT`** and **`PARTIALLY_TRANSFERRED`**, which the
  webhook event catalogue does not list.
- The REST list endpoint uses different names again: `id` not `transferId`,
  `name` not `recipientName`, `createdAt` not `date`. The projection accepts all.

### ukkera

Sends different field names from the project brief:

| Brief | Actual |
|---|---|
| `phone` | `student_phone` |
| `payment_date` | `date` |
| `course` | absent — **`package_name`** instead |
| `order_id` | absent — `transfer_id` instead |

Contrary to what ukkera support said, **package data does arrive by webhook**.
The projection accepts both spellings of every field, and a payload with
`event: "test"` is acknowledged and ignored rather than inventing a student.

The header must be named exactly **`Authorization`** with value `Bearer <token>`.

---

## 7. Open issues

1. **`transfer_id` (ukkera) == `merchantOrderId` (Kashier)?** Unconfirmed.
   This is why the payment↔subscription link is a soft join plus a manual
   override table, never a foreign key — a wrong FK would reject real payments
   at ingest, a wrong soft join only shows up in the reconciliation report.
   **Verify on the first real payment.**
2. **Transfer webhooks arrive unsigned.** Kashier sends no
   `x-kashier-signature` header at all for this account, so they are correctly
   refused. Payout tracking therefore runs through `kashier-sync-payouts`
   instead, which is better provenance anyway. A Transfer API Key must be
   requested from Kashier support to enable signed transfer webhooks.
   **Related and currently blocking:** `KASHIER_SECRET_KEY_LIVE` is not set, so
   the sync fails with `no_secret_key_for_mode` and has never run.
   [`docs/kashier-payouts.md`](docs/kashier-payouts.md) §3 is the fix.
3. **Kashier live webhook not yet registered** — only test mode is; every row
   in `kashier_events_raw` is `mode = 'test'`. Register it before real payments
   flow: [`docs/kashier-live-webhook.md`](docs/kashier-live-webhook.md) is the
   step-by-step, including the two live Payment API keys that must both be
   listed in `KASHIER_PAYMENT_API_KEY_LIVE`.
4. **ukkera export column headers unknown.** The import page auto-detects from
   Arabic and English aliases and allows manual remapping.
5. ~~Logo not yet applied~~ — **resolved.** The supplied artwork is white on a
   transparent ground, which is why it read as a blank white image. It is
   cropped into `web/public/logo-mark.png` (the hexagon) and
   `web/public/logo-lockup.png` (mark + wordmark), and composited over the
   brand ramp for `src/app/icon.png`, `apple-icon.png` and `favicon.ico`.
   Because the artwork is white, it always needs a coloured ground.

---

## 8. Design system

Direction: one person's daily money console. The brand's violet→pink ramp is a
**depth** scale (violet = structure, pink = the live signal). Money colour is
deliberately outside that ramp so `+`/`−` is never ambiguous.

```
#3F1E6B deep violet    structure, chrome
#5C2F80 purple         brand, primary actions
#E4588F pink           focus, selection, accents
#FFAAAE light pink     soft fills
```

Form: the subject is organic chemistry, so the geometry is the benzene ring —
soft continuous curves, and one hexagon lattice, behind the sign-in panel only.

Type: **Readex Pro** (display) + **IBM Plex Sans Arabic** (body/data, real
tabular figures). Tokens live in `web/src/app/globals.css`; dark mode overrides
the raw custom properties because Tailwind v4 only reads top-level `@theme`.

**Radius and elevation are `@theme` tokens, used as `rounded-card`,
`rounded-field`, `shadow-card`.** Never as `rounded-[--radius-card]` — that is
Tailwind v3 syntax which v4 reads as a literal value, so it silently produces
no radius at all. That exact mistake left every card, button and input in the
app with square corners and no shadow. Elevation is always two shadows, a 1px
contact plus a wide ambient one; on dark, a 1px top highlight replaces the
contact shadow, which cannot describe an edge against a dark ground.

Bilingual AR-RTL / EN-LTR via a cookie read server-side, so `dir` is correct on
first paint. Latin identifiers use `.ltr-id` to survive RTL layout.

Light/dark works the same way: a cookie renders `data-theme` on `<html>`, and
every colour is declared **once** as `light-dark(light, dark)` so the theme
button only has to change `color-scheme`. Repeating the palette in a
`prefers-color-scheme` block and again under `[data-theme='dark']` would be
three places to keep in sync, and native controls would still follow the OS.

---

## 9. Testing

```bash
cd supabase && deno task test        # 72 Deno tests
# SQL regression suite:
psql "$DATABASE_URL" -f supabase/tests/projections.test.sql
cd web && npm run lint && npm run build
```

Bugs the tests have actually caught (each is now a regression test):
- `min(uuid)` does not exist in Postgres
- a `CASE` returning text will not coerce to an enum
- `v_wallet_balances` counted test entries while the P&L excluded them, so the
  books stopped reconciling
- `reconcile_transactions` hardcoded `mode = 'live'` and reported every
  test-mode row as missing — a confidently wrong answer
- flat transfer payloads were classified `unknown` and routed to the wrong
  projection

---

## 10. Operations

**"I never got the webhook"** — the Health page, or:

```sql
select * from public.v_ingest_health;
select received_at, event, state, process_error
  from public.kashier_events_raw where state = 'failed' order by received_at desc;
select * from public.webhook_rejections order by received_at desc limit 20;
```

**After fixing a projection bug** — the sweeper runs every 5 minutes; force it
with the Health page button or `select app.sweep_failed_events();`.

**Deploy**

```bash
supabase functions deploy kashier-webhook      --no-verify-jwt
supabase functions deploy ukkera-webhook       --no-verify-jwt
supabase functions deploy kashier-sync-payouts --no-verify-jwt
```

Dashboard → Vercel, root directory `web`.

See [`docs/FEATURES.md`](docs/FEATURES.md) for what every page does,
[`docs/kashier-payouts.md`](docs/kashier-payouts.md) for how you actually get
paid and how to test it, [`docs/kashier-live-webhook.md`](docs/kashier-live-webhook.md)
for going live with real payments, [`docs/runbook.md`](docs/runbook.md) for the
cutover procedure, and [`docs/architecture.md`](docs/architecture.md) for why
the data flows the way it does.

---

## 11. Test vs live in the UI

The top bar carries a **mode switch**, remembered in a cookie and read
server-side like the locale. It scopes everything with a mode of its own —
payments, transfers, ingest health, reconciliation, the ledger, the journey —
and tints the whole bar amber on test.

It deliberately does **not** scope the money views. Balances, profit and
reports exclude test traffic in the database, which is rule 7; a UI toggle must
not be able to switch that off. Those pages show a banner saying so instead of
silently ignoring the switch.

---

## 12. Pricing and instalments

`/pricing` is where a subscription gets a price and a payment plan, and where
money received off-Kashier is recorded.

What a subscription is worth is `coalesce(s.total_due, pk.price, s.amount, 0)`,
so there are three places a price can come from and the page names which one is
in effect on every row. Setting a subscription's own `total_due` overrides the
package; clearing it back to **null** — not zero — returns it to the package
price. Zero and "unpriced" are different states and the UI keeps them apart.

Payments recorded here go through `add_manual_revenue`, never a direct insert:
RLS denies writes to `ledger_entries`, so the revenue entry and the wallet
movement stay one transaction the database controls. Nothing is deleted, only
voided.
