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
- **`GET /v2/transfers` rejects `sortType`.** Not ignores — 400s. That single
  parameter is why the payout sync failed on every run for days while
  `/v2/account` answered 200 beside it with the same key. The working call is
  `/v2/transfers?limit=&page=`, and the response is
  `{message, data:{inProgressTransfersCount, transfers}, pagination}`.

**`payoutFees` is per TRANSFER, not per payment (0038).** 0022 read the account
endpoint's `payoutFees: 5` as a flat bank fee on every transaction and applied
it everywhere. Kashier's own balance disproves it to the piastre:

```
totalBalanceBeforeLastTransfer   292.08
lastTransfer                   − 100.57
totalBalance                   = 191.51   ← what the API reports

settled_amount payment #1         95.84
settled_amount payment #2       + 95.67
                                = 191.51   ← the same number
```

The balance is credited with `settled_amount` untouched — gross minus Kashier's
commission and its VAT, nothing else. Had 5 been withheld per payment it would
read 181.51. The transfer also removed exactly its own amount from the balance,
so nothing was withheld on the way out either: the fee comes off the transfer,
once, and reduces what the bank receives.

Two consequences follow from the same fact:

* **The Kashier balance is NET.** Comparing it against our gross figure — which
  `v_money_position`'s panel did — can never reach zero; once everything settles
  it stays short by exactly the fees. Net against net closes.
* **The gap between our books and their balance is settlement lag**, one payment
  at a time, and nothing else.

**Transfers are not being ingested.** `kashier_events_raw` holds `pay` events
and zero `transfer` events; `public.payouts` is empty. Kashier moved 100.57 out
on 9 Sep 2026 while the system was live and nothing told us. Until that webhook
is enabled at Kashier, no screen here can say whether a payout reached the bank
— the money position now says so out loud instead of showing a silent zero.

### ukkera

Sends different field names from the project brief:

| Brief | Actual |
|---|---|
| `phone` | `student_phone` |
| `payment_date` | `date` |
| `course` | `course_name` **and** `course_id` (added by ukkera Sept 2026) |
| `order_id` | absent — `transfer_id` instead |

The projection accepts both spellings of every field, and a payload with
`event: "test"` is acknowledged and ignored rather than inventing a student.

The header must be named exactly **`Authorization`** with value `Bearer <token>`.

**ukkera's `transfer_id` is unique per purchase** (846, 847, 839…). This is a
different field from the `transfer_id` inside Kashier's base64 `metaData`, which
is the payment LINK id and is the same for every buyer. Two fields, one name,
opposite cardinality — see open issue 1.

#### What a course title carries

Titles arrive as one string in a fixed vocabulary:

    ORGANIC 1 - Azhar Cairo - Girls - 2027 - Clinical
    └ subject+level └ university └ section └ class year └ track

`app.parse_course_name` classifies each token **by shape, not by position** —
not every title carries all five parts, and a positional parser turns a missing
section into a university called "2027". Anything left over is the university,
which is the only part with no fixed vocabulary; a title where nothing else was
recognised yields nothing rather than inventing one. `public.university_aliases`
binds spellings to names so "Azhar Cairo" and "الأزهر – القاهرة" do not become
two reporting groups.

#### Packages and instalments

`app.parse_package_name` classifies a package as `full`, `chapter`,
`installment` or `other`. Instalment is checked first: "الكورس كامل بالقسط" is
an instalment package that also says "full", and how it is *paid* is the fact
that decides what the student still owes.

A three-instalment enrolment arrives as three separate purchases months apart,
with nothing in either feed linking them. Each stays its own subscription — that
is what the money plumbing matches on — and `public.installment_plans` sits above
them holding the course price. `packages.price` is one instalment;
`packages.total_price` is the course. Without the latter, a student who has paid
one of three reads as settled.

---

### Viewing, editing and deleting records

Three verbs, in the same order, on every list in the app: **عرض / تعديل / حذف**.
`web/src/components/record-actions.tsx` holds all three, so a screen wires them
rather than reinventing them.

Deleting is the one that needed a rule. Every table grants admins ALL, and the
foreign keys made a plain delete quietly destructive — a student's
`installment_plans` CASCADE away and their `ledger_entries.student_id` is SET
NULL, leaving the money on the books, correct in total, belonging to nobody. No
error is raised, so nothing ever tells you it happened.

> **A record that money points at cannot be deleted.**

Enforced by `public.delete_record`, not by the UI, which can only ever suggest.
The flow is:

1. `public.describe_record(kind, id)` — what is attached, and whether any of it
   is money. The dialog opens with facts instead of "are you sure?".
2. `public.delete_record(kind, id)` — returns `{ok:false, reason:'has_money'}`
   rather than raising, so the screen can explain rather than apologise.
3. `public.archive_record(kind, id)` — what a blocked delete offers instead.
   Keeps the history, leaves the lists. For a plan, archived means *closed*.

`app.record_links` is the single place that knows the reference graph.

Ledger entries are the exception and stay outside this: they are append-only
and RLS grants the client SELECT only. "Remove" there means **void**, because an
expense that was recorded and then reversed is a different fact from one that
never existed.

**And the door beside it (0037).** Supabase's default privileges hand
`authenticated` the full table privilege set on everything in `public` —
`arwdDxtm` — whatever the migrations grant. `ledger_entries` grants only SELECT,
forces RLS, and has a SELECT-only policy; it still held **TRUNCATE**, which is
not subject to row-level security at all. A signed-in user RLS refuses every row
to could still empty the ledger with one statement. Verified before it was
fixed, not assumed.

`TRUNCATE`, `REFERENCES`, `TRIGGER` and `MAINTAIN` are now revoked from `anon`
and `authenticated`, and removed from the default privileges for `postgres` so
the next `create table` does not hand them back. `SELECT/INSERT/UPDATE/DELETE`
are untouched — those RLS governs.

`public.v_client_access_audit` is the standing check, shown on **/health**.
Empty is healthy. Every row is either a privilege the client holds that RLS
cannot govern, or a reachable table with no RLS in front of it. This project has
already watched a security setting come back twice (`security_invoker`), so the
fix is checked as well as applied.

---

### Universities and specialisations

The two things a student and a course are classified by. Both are **rows**
(`public.universities`, `public.tracks`), both are managed on
`/classification`, and both appear as a dropdown wherever a student or a course
is edited — with a `+ جديد` beside it, because a missing university is the
normal case and walking someone to another screen loses the form they are in.

**A spelling is bound to a row, not to a name.** `university_aliases` and
`track_aliases` map every way an upstream might write it — `Azhar Cairo`,
`AL-AZHAR CAIRO` — onto one row, and learn spellings they have not seen. Both
tables carry the row's **id**: before that they stored the display name, so
renaming a university left the alias pointing at a name that no longer existed
and the next delivery carrying the old spelling **created a second university**.
The rename looked fine right up until the next payment.

**A student's classification is read out of the courses they bought**, by
`app.classify_student`, under two rules:

* *Unanimity or nothing.* A student on two universities' courses has no one
  university, and a guess only beats a blank until somebody believes it.
* *The admin wins, permanently.* `students.classification_locked` is set by a
  trigger the moment either field is changed by hand — including changed to
  **empty**. That is what makes a deliberately cleared field stay cleared
  instead of reappearing after the next payment.

Filters follow the id, never the word: `Clinical` and `CLINICAL` in two course
titles are one specialisation and must narrow a list as one. Reports gain
**التخصصات** beside **الجامعات**, both net of the gateway's cut.

Deleting either is allowed — no money points at a classification — but the
dialog says what it un-labels first. The foreign keys are SET NULL, so courses
and students survive it and simply become unclassified.

---

## 7. Open issues

1. **What identifies a purchase? — settled, after getting it wrong once.**
   Each side has its own key and neither carries the other's, so a subscription
   holds **both**: `merchant_order_key` (Kashier's `merchantOrderId`, built as
   `transfer-<payer phone>-<epoch ms>`) and `ukkera_transfer_id` (ukkera's own
   transfer id). Whichever side arrives second **adopts** the row the first one
   made, bridged on same student + same amount to the piastre + within four
   hours of the payment's transaction date. Before this, each side wrote its own
   row and two purchases produced four subscriptions.

   The first real payment suggested otherwise. Its base64 `metaData` carried
   `transfer_id: 459`, `project_ukkera_event` already read `transfer_id` as an
   order-id candidate, and 0020 concluded that was the shared key. **It was
   not.** The second real payment carried the same `transfer_id: 459` for a
   different buyer, a different phone and a different transaction — because
   `transfer_id` identifies the ukkera payment LINK (package + instructor,
   alongside `custom_gateway_instructor_id`), so every buyer through that link
   shares it. Keying on it merged two students onto one order and attributed
   one person's money to another. Corrected in 0025.

   The lesson is in the schema comment now: `payments.ukkera_transfer_id` says
   never to join on it. A conclusion drawn from one observation of an external
   system is a hypothesis, and the second observation is what tests it.

   Confirmed by the live data: both payments carry link id `459`, while ukkera's
   own transfer ids for the same two purchases are `846` and `847`.

1b. **Gateway fees are not expenses, and gross payments are not revenue.**
   Settled in 0026–0028. The ledger records a student's payment as `revenue`
   and Kashier's cut as its own entry type `gateway_fee`; `app.pnl_expense`
   excludes it, `app.pnl_fee` counts it, and every view reports
   `student_payments − gateway_fees = revenue`. Net profit is unchanged by the
   reclassification, which is the proof it was only ever a naming error.

2. **No payout has ever been recorded, and it is the transfers REST call.**
   `KASHIER_SECRET_KEY_LIVE` is set and `GET /v2/account` returns real balances
   — two accounts, the primary holding 191.51, synced 9 Sep 2026. `GET
   /v2/transfers` answers **400** every time. Same host, same key: the key is
   right and the request is not. The function logged only the status code,
   which is why it went unexplained for days; it now keeps Kashier's response
   body and probes the plausible URL shapes on the first page, remembering
   whichever answers. Press تحديث من كاشير once and the screen — not just the
   log — says what Kashier objected to.
   Transfer webhooks are the other route and are worse: Kashier sends them with
   no `x-kashier-signature` header at all for this account, so they are
   correctly refused, and a Transfer API Key has to be requested from support
   to enable signing. The REST pull is better provenance and is one 400 away.
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
paid and how to test it, [`docs/kashier-testing.md`](docs/kashier-testing.md)
for Kashier's test cards and how to settle the order-id question,
[`docs/kashier-live-webhook.md`](docs/kashier-live-webhook.md)
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
