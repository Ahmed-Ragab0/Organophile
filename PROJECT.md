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
deno task test     # 79 tests
deno task check
deno task lint
```

`web/.env.local` needs `NEXT_PUBLIC_SUPABASE_URL` and
`NEXT_PUBLIC_SUPABASE_ANON_KEY`. Both are public by design — RLS protects the
data. **The service role key must never appear in `web/`.**

### Putting it online

Vercel, with **Root Directory `web`** — the repository root is not the Next app.
Two environment variables, and two things afterwards that fail silently if
missed: Supabase's Site URL / Redirect URLs, and `DASHBOARD_ORIGINS` for the
sync button's CORS. Custom domain, DNS and the platform comparison are in
[`docs/deploy.md`](docs/deploy.md).

The database, auth, webhooks, Edge Functions and the 15-minute payout cron all
stay on Supabase. Vercel serves the dashboard and nothing else, so neither
Kashier nor ukkera has any URL to change.

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
   `void_ledger_entry`, `pay_payslip`, `unpay_payslip`. Payroll extends the
   same rule to its own document: `payslips.paid_at` is refused to a client
   too, so "paid" cannot be written without money moving in the same
   transaction.
9. **Signing in, being let in, and being allowed to do a thing are three
   different questions.** Supabase Auth proves who you are; `public.staff`
   decides whether you may see anything at all; `roles` + `role_permissions`
   decide what. Every policy goes through **`app.can('<domain>.<action>')`**,
   and `src/lib/supabase/middleware.ts` asks `my_access()` before rendering, so
   a page you cannot use is a redirect rather than an empty screen. The
   redirect goes to the first page you CAN use, never to `/login` — that would
   be a loop for any role without the overview.
10. **One role holds everything and cannot be emptied.** `roles.is_superuser`
   is true for exactly one row, enforced by a partial unique index. It holds
   every permission implicitly, including ones added by later migrations, so
   adding a permission can never lock the owner out of what it guards. Three
   more rails, all triggers: the last active admin cannot be removed or
   demoted, you cannot change your own role or switch yourself off, and the
   superuser role cannot be given explicit permission rows (which would go
   stale).

---

### Staff, roles and permissions

Four seeded roles, and the owner can add more:

| Role | Holds |
|---|---|
| **مدير** (`admin`) | everything, implicitly and permanently |
| **محاسب** (`accountant`) | money read+write, payroll read+write, own tasks, payments/reports/students/subscriptions read |
| **سيلز** (`sales`) | students and subscriptions read+write, courses/reports read, own tasks |
| **مشاهدة** (`viewer`) | every `.read` except staff |

Permissions are `<domain>.<action>` with action ∈ {read, write}, over thirteen
domains: overview, students, courses, subscriptions, money, **payroll**,
**tasks**, **team**, payments, reports, settings, staff, system.

**`tasks` and `team` are two domains rather than three levels of one.** Every
other domain here is all-or-nothing, which was right while every domain was
about the business. Tasks are about people: a salesperson must be able to work
their own board without reading their colleagues'. So `tasks.*` means yours and
`team.*` means everybody's — and the two-action rule survives intact.

`payroll` is the one domain deliberately kept out of `viewer`. "Every `.read`
except staff" was written before salaries existed, and a list of what your
colleagues earn is not a report. It is also the one permission whose name does
not contain the word money and yet spends it — `payroll.write` includes paying,
so granting it is a money decision. The **catalogue is seeded and not editable from the
app** — a permission nobody's code checks is worse than no permission — but
which of them a role holds is entirely up to the owner.

Three things are readable by any staff member regardless of role, because they
are the contents of every dropdown in the app and gating them produces empty
selects on screens the person is allowed to use: universities, tracks, and the
two settings lists. They carry no money and no personal data.

**Creating a login goes through the `staff-admin` Edge Function**, because
`auth.admin.createUser` needs the service role key and that key must never be
in `web/`. The function re-checks the caller through `my_access()` using the
caller's own token, does the one privileged step, and then writes the `staff`
row **as the caller** — so the last-admin and no-editing-yourself triggers stay
in force. Removing a person is the same in reverse: the `staff` row goes first,
so a refusal leaves the account untouched.

**This is a deliberate change of posture, and it has a cost.** The allowlist
used to be editable only in the SQL console, which meant a stolen session could
not create an accomplice. It can now, if it belongs to someone with
`staff.write`. What limits it: only the admin role holds that permission by
default, every row records `created_by`, and account creation is a logged call
to a function that re-verifies the caller.

**Break-glass**, if nobody can get in — in the Supabase SQL editor:

```sql
insert into public.staff (user_id, email, role_id)
select u.id, u.email, (select id from public.roles where code = 'admin')
  from auth.users u
 where lower(u.email) = lower('someone@example.com')
on conflict (user_id) do update
  set role_id = excluded.role_id, is_active = true;
```

**A new account that logs in and bounces back to the login page with
"الحساب ده مش مصرّح له بالدخول" is this working, not failing.** It happened on
9 Sep 2026 with a second owner account and looked like a bug for exactly as long
as it took to read the table.

**Public signup should be off.** Accounts are created from the Staff page now,
so `Authentication → Sign In / Providers → Email → "Allow new users to sign up"`
belongs unchecked. Leaving it on lets anyone create an `auth.users` row; RLS
still shows them nothing, but a staff list works better when the queue in front
of it is empty.

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

**Payroll**
- `employees` — who is PAID. Not the same list as `staff`, which is who may
  SIGN IN; the link between them is one nullable column.
- `payroll_periods` — one month, moving draft → review → approved → closed.
- `payslips` — one person's month. Snapshots the name and job title, keeps its
  own totals, and freezes the moment it is paid.
- `payslip_items` — what the figure is made of. Their sum IS the payslip's
  totals, kept by trigger.
- `salary_components` — the vocabulary those lines are filed under.
- `payroll_settings` — one row: company name, thank-you template, where
  salaries land in the books.

**Work**
- `projects` — what tasks are filed under, and where progress is measured.
- `tasks` — one thing, assigned to one EMPLOYEE, in one of four states.
- `task_sessions` — a stretch of time on a task, timed by the app or typed in
  and reviewed. Their sum is every hour figure in the system.

**Access**
- `staff` — who may use the system. One row per person; there is no second list.
- `roles`, `permissions`, `role_permissions` — what each of them may do.
  `permissions` is seeded by migration and SELECT-only at the grant level.

**Derived onto the student** — `students.university_id`, `students.track_id`,
`students.level`, all filled by `app.classify_student` and frozen by
`students.classification_locked`. `v_levels` lists which levels exist at all,
so a filter's options come from the data rather than from a hard-coded 1..4.

**Lists the owner edits** — every dropdown in the app comes from one of these,
and each is managed on a screen rather than in a deploy.
- `universities`, `tracks` — on the Classification page.
- `expense_categories` — on the Settings page. `ledger_entries.category_id`
  points at the row; `ledger_entries.category` keeps the text as written at the
  time, and the views read `coalesce(category_row.name, category_text)` so a
  rename reaches every row that has an id and never rewrites what it cannot.
- `plan_kinds` — on the Settings page. Four rows are `is_system`: their **code**
  (`full`/`chapter`/`installment`/`other`) is what the name parser writes and
  what opens an instalment plan, so it is protected by a trigger. Their **name**
  is display only and can be changed freely. `packages.kind` and
  `subscriptions.plan_kind` are foreign keys to `plan_kinds(code)`
  ON UPDATE CASCADE / ON DELETE RESTRICT.

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
`v_revenue_by_university`, `v_expenses_by_category`, `v_expense_categories`,
`v_plan_kinds`, `v_payments_enriched`,
`v_unmatched_payments`, `v_unpaid_subscriptions`, `v_ingest_health`

**Functions the app calls**
`my_access` (who am I and what may I do — the one call the middleware makes),
`describe_record` / `delete_record` / `archive_record`,
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
| Payout sync (POST, `system.write` or service key) | `…/functions/v1/kashier-sync-payouts?mode=live` |
| Staff accounts (POST, `staff.write`) | `…/functions/v1/staff-admin` |

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
- **`GET /v2/transfers` rejects `sortType=desc`.** Not ignores — 400s, with
  `"sortType" must be one of [1, -1]`. That single parameter is why the payout
  sync failed on every run for days while `/v2/account` answered 200 beside it
  with the same key. The working call is `/v2/transfers?limit=&page=`, and the
  response is `{message, data:{inProgressTransfersCount, transfers}, pagination}`.
  `accountId` is rejected too — `"accountId" is not allowed`.

- **`/v2/transfers` never lists your settlements.** With the call fixed it
  answers `pagination.total: 0`, unfiltered, while the same account reports
  `lastTransfer: 100.57`. They are different products: `/v2/transfers` is the
  bulk-transfer API — money a merchant sends *to recipients* — and Kashier
  settling your own balance into your own bank is not one of those. Probed to
  exhaustion on 9 Sep 2026 (`&merchantId`, `&status=TRANSFERRED`, `&accountId`,
  `&sortType`); all either 0 or refused.

  So the **only** record of a settlement is the account endpoint:
  `lastTransfer`, `lastTransferDate`, `lastTransferId`,
  `lastTransferReference`, `totalBalanceBeforeLastTransfer`. That is a snapshot
  of the LAST one — two settlements between two syncs and the first is gone.

  Those fields become the payout row (0039), and the sync runs every 15 minutes
  on `pg_cron` so the window in which a settlement can be missed stays small.
  `app.sync_kashier_payouts()` reads the service role key from Vault — never a
  migration, a repo or a log — and returns `{ok:false,
  reason:"no_service_role_key"}` rather than failing when it is not stored.

- **Kashier's opening balance is not yours to attribute.** It was already
  holding 100.57 before this system recorded a payment, and the 9 Sep transfer
  moved exactly that: 292.08 − 100.57 = 191.51, which is 95.84 + 95.67, the two
  settled payments, untouched. Recorded once on
  `kashier_account.opening_balance` with that arithmetic as its note.
  `app.transferred_ours()` takes it off the top, so FIFO attribution and
  `awaiting_payout` never report a student's money as banked because Kashier
  moved money that was never ours.

**The bank fee is 5 per payment, and the balance cannot tell you that (0038,
0040, 0041).** 0022 applied a flat 5 per transaction. 0038 removed it, arguing
from Kashier's own balance:

```
totalBalanceBeforeLastTransfer   292.08
lastTransfer                   − 100.57
totalBalance                   = 191.51   ← what the API reports

settled_amount payment #1         95.84
settled_amount payment #2       + 95.67
                                = 191.51   ← the same number
```

Every figure there is right and the conclusion drawn from it was not. What it
proves is that the balance is credited with `settled_amount` untouched — that
the fee is **not taken at settlement**. It says nothing about what Kashier
deducts when it moves that balance to a bank account, because that side appears
in no API: `/v2/transfers` never lists a settlement, and the account endpoint
gives an amount with no breakdown. A fee charged per transaction *at payout*
fits every observation as well as a flat fee per transfer does.

0040 restores 5 per payment, on the account owner's reading of the bank
statement — the only view of the bank side anyone has. **Still open:** per
transaction, or once per transfer. The first settlement covering several
payments answers it, by comparing what the bank receives against
`sum(settled_amount)`. Until then it is a recorded figure, not a derived one,
and it should not be argued away from a balance a second time.

Two things follow, and 0041 exists because the second one bites immediately:

* **Kashier's balance is `settled_amount`** — net of their commission and VAT,
  and of nothing else.
* **So compare it against `awaiting_settled`, never `awaiting_payout`.** Their
  balance has not paid the bank fee yet, so holding our after-fee figure against
  it stays short by 5 per payment for ever. Settled against settled reaches
  zero; the current gap is 95.67, which is payment #3 still inside the
  settlement window, and nothing else.

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

**The track vocabulary is a list, and a spelling that is not on it is dropped
silently.** This account writes `Ph-D`; the parser knew `Pharm D`, `PharmD` and
`PHARM-D`, so every `Ph-D` course had no track — and therefore every student on
one had no track either. Nothing errored; the filter was simply empty. Fixed in
`0048`, where the `Ph-D` pattern is **anchored** (`^PH\s*-?\s*D$`) unlike the
`PHARM` ones beside it: `PHD` inside a longer word is not a track, but a token
that is exactly that is nothing else. When a new spelling appears, this is the
list to add it to — and the symptom to watch for is a filter that returns
nothing rather than an error.

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

Three fields are read down: **university**, **track**, and — since `0048` —
**level**, the "Organic 1/2/3/4" that the course title already carried and the
student never inherited. All three follow the same two rules:

* *Unanimity or nothing.* A student on two universities' courses has no one
  university, and a guess only beats a blank until somebody believes it. Level
  is deliberately the same: someone taking Organic 1 and Organic 3 at once is
  not "in" either, and picking the higher would be a guess that reads as a fact.
* *The admin wins, permanently.* `students.classification_locked` is set by a
  trigger the moment any of the three is changed by hand — including changed to
  **empty**. That is what makes a deliberately cleared field stay cleared
  instead of reappearing after the next payment.

**But the filter is broader than the field.** `v_student_financials` also
carries `course_levels`, `course_track_ids` and `course_university_ids` — every
value the student's enrolments actually hold — and `search_students` matches
*either*. Without that, a student whose own track went blank because their
courses disagreed was invisible under a track filter while being enrolled on a
course of exactly that track. The question a person is asking is "who is in
this", not "who has this written on them".

Filters follow the id, never the word: `Clinical` and `CLINICAL` in two course
titles are one specialisation and must narrow a list as one. Reports gain
**التخصصات** beside **الجامعات**, both net of the gateway's cut.

`students.group_name` is **not** the level and never was: it is ukkera's
free-text "group" column, and calling it *المجموعة* on screen is what made the
two look like one field for as long as they did. المجموعة is the level now;
that column is labelled *جروب يوكيرا*.

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
# SQL regression suites (both roll themselves back; safe against live):
psql "$DATABASE_URL" -f supabase/tests/projections.test.sql
psql "$DATABASE_URL" -f supabase/tests/payroll.test.sql   # 32 assertions
psql "$DATABASE_URL" -f supabase/tests/tasks.test.sql     # 40 assertions
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

Dashboard → Vercel, root directory `web`. The whole procedure — environment,
the two settings that fail silently afterwards, a custom domain and why Vercel
rather than the alternatives — is [`docs/deploy.md`](docs/deploy.md).

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

---

## 13. Payroll

`/payroll` is three screens behind one tab bar: the monthly **cycles**, the
**people** who get paid, and the **settings** that decide what the thank-you
message says and where a salary lands in the books.

### A salary is a document before it is a payment

That order is the whole design. The old way of paying a salary was one line in
the expenses screen — "مرتبات، 6000، من فودافون كاش" — which keeps the books
balanced and answers nothing else: not who was paid, not what the figure was
made of, not whether anybody agreed to it first.

```
employee → period (draft → review → approved → closed) → payslip → items
                                        ↓
                                   pay_payslip
                                        ↓
                            one expense in the ledger
```

Nothing is paid before the cycle is **approved**, and nothing changes after it
is **paid**. `pay_payslip` writes the ledger entry and stamps the payslip in
one transaction, so there is no window where a payslip says paid and a wallet
disagrees.

### The six rails

Each of these is a trigger, and each has a regression test in
`supabase/tests/payroll.test.sql`:

| Rail | Why |
|---|---|
| `paid_at` is refused to clients | otherwise anyone with `payroll.write` marks a salary paid with a plain PostgREST `UPDATE` and no money ever moves |
| a paid payslip cannot be edited or deleted | a document that changes after the money left records nothing |
| its lines cannot be added to or removed | same reason, one level down |
| its ledger entry cannot be voided from the ledger screen | the payslip would still say paid, and two records of one fact would disagree — reverse the payslip instead |
| deductions cannot exceed the salary | a negative net is not a payroll, it is a bug |
| a cycle with paid salaries cannot go back to draft, or be deleted | the money has already gone |

`pay_payslip` and `unpay_payslip` are the two doors, and both set a
transaction-local `app.payroll_paying` flag — the same trick `0048` uses for
autoclassification. The guards read it, which is how they tell a write of
their own from a client writing the same column.

### Reversal, not deletion

`unpay_payslip` **voids** the ledger entry (rule 6), returns the money to the
wallet, reopens the cycle, and makes the payslip editable again. The payslip
lets go of `ledger_entry_id` because the constraint says paid and entry are one
fact — but the voided entry still carries the payslip's id in its metadata, so
"what was this reversal about" stays answerable from the books alone.

### The message

The thank-you note lives in `payroll_settings.thanks_template`, not in the
code, because it is the owner's voice and the wording of a message about
somebody's salary should not need a deploy. `{placeholders}` are filled from
the payslip; an unknown one is left standing rather than blanked, so a typo
shows up in the preview instead of going out.

`{bonus}` is defined as **every earning that is not a commission**, not as the
lines filed under the component called حافز. That is what makes the arithmetic
in the message close exactly:

```
baseSalary + commissions + bonus − deductions = net
```

It is sent through a `wa.me` link, so it goes out from the owner's own WhatsApp
as a person writing to a colleague. Egyptian numbers are written four
different ways in a phone book (`01012345678`, `+20 10 …`, `0020 …`,
`1012345678`) and `whatsappNumber()` normalises all of them.

### The printed payslip

`/payslip/[id]` sits **outside** the dashboard shell, because it is a sheet of
paper and a sheet of paper has no sidebar. It is still gated: the middleware
asks `payroll.read` for `/payslip`, and RLS refuses the row regardless.

PDF comes from the browser's own print dialog, not a library. That is not a
shortcut — Arabic needs contextual letter shaping and RTL runs, and the
client-side PDF libraries either get that wrong or need a shaping engine plus
an embedded font shipped to every visitor. The browser has both already.

The print stylesheet's first line does most of the work:

```css
@media print { :root { color-scheme: light !important; } }
```

Every colour in this system is declared once as `light-dark(…)`, so pinning
the scheme flips the whole palette back to ink-on-white in one declaration.
Without it, somebody working in dark mode prints white text on black.

The net is printed twice — in figures and **in words** (تفقيط,
`lib/number-words.ts`). That is not decoration: every payslip and receipt in
Egypt carries both, because a digit can be altered after signing and a
sentence cannot. Arabic number grammar is correctness there, not polish —
"مائة ألف" and "خمسة وعشرون ألفًا" take different forms of the same word, and
getting it wrong is the tell of a generated document.

### What is deliberately not built

- **Automatic commission.** Computing "5% of what this person sold" needs
  sales attributed to a person, and nothing in this database attributes them
  yet. A commission is a typed line with a note until that exists. The shape is
  ready for it; the arithmetic is not invented.
- **A pay grade / contract table.** One base figure per person is what this
  business has.
- **Self-service.** An employee cannot read their own payslip, because an
  employee is not necessarily a login at all. The link exists for the day that
  changes.

---

## 14. Tasks and productivity

`/tasks` is a board, a team report, and a project list. It answers the question
payroll cannot: **section 13 says what a person cost; this says what they did.**

### A board that opens on your own work

Even for the owner. A board that opens on forty cards belonging to five people
is a report you have to filter before you can use it; a board that opens on
yours is a place to start the day. "الفريق كله" is one click away for anybody
holding `team.read`.

The switch is a **filter on rows the database already agreed to send**. It is
not the security boundary — RLS is — so somebody without `team.read` who
somehow flipped it would see exactly what they saw before.

### Working a task and managing it are different jobs

RLS is row-level and cannot say *which columns* somebody may change, so
`app.guard_task` says it:

| Anyone assigned a task may | Only `team.write` may |
|---|---|
| move it across the board | reassign it |
| reorder it in a column | change its due date, priority or estimate |
| add a task **for themselves** | assign work to somebody else |
| log their own time | approve or reject time |
| | delete a task or a project |

Without that trigger, a salesperson could hand their own overdue work to a
colleague and the board would look perfectly tidy afterwards.

### The clock

One clock per person, enforced by a partial unique index as well as by
`start_task_timer` — starting a second task ends the first, because the honest
reading of "I started something else" is that the previous thing stopped, not
that the request was invalid. A forgotten Monday timer plus a fresh Tuesday one
is how every hour after that gets counted twice.

Session boundaries use **`clock_timestamp()`, not `now()`**. `now()` is the
transaction's start time and does not move while it runs, so a start and a stop
inside one transaction land on the same instant — a zero-length session the
check constraint then refuses. This was a real failure, caught by the first
probe run against the live database.

### Typed-in time is a claim, not a fact

| | counts immediately | needs agreement |
|---|---|---|
| **timer** | ✅ the app watched it | |
| **manual** | | ✅ `pending` until `review_time_entry` |

`app.session_counts(status)` is the single definition of "counts", written once
and read by every view. Hours appearing with two different definitions on two
screens is the fastest way to lose trust in both.

`log_manual_time` refuses overlaps outright. Two claims covering the same hour
is the one error a reviewer cannot catch by reading, because each entry looks
perfectly reasonable on its own. Back-to-back work is not an overlap — the
comparison is half-open, so 14:00–15:00 sits happily after 13:00–14:00.

### Names are not salaries

`employees` is gated on `payroll.read`, because that table holds what everybody
earns. But a card has to say "assigned to Mariam", and a sales manager who may
see the team's work has no business seeing the team's pay.

Joining `employees` into the task views would have forced the choice: grant
payroll to everyone with a board, or show every card as unassigned. So the join
goes through **`app.team_members()`** — SECURITY DEFINER, and the columns it
returns are the whole of its promise: name, job title, whether they are active,
and how long their working day is. No salary, no phone, no wallet.

`v_team_productivity` then adds `where app.can('team.read') or e.id =
app.my_employee_id()`, so somebody with only `tasks.read` sees exactly one row —
their own. Without that line they would have seen the whole roster with every
figure zeroed, which leaks the shape of the team while appearing not to.

### A task belongs to an employee, not to a login

`employees` is already this system's answer to "who works here" (section 13),
and it is the list the owner maintains. Somebody with no login can still be
given tasks and still appears in the productivity report; they just cannot open
the app to see them. Assigning to `staff` instead would force the roster of
people who do work and the roster of people who can sign in to be the same
list — which they already are not.

The consequence worth knowing: **a login that is not linked to an employee row
cannot start a timer.** The board says so in a notice rather than failing
silently, and the fix is one field on Payroll → الموظفين.

### Card positions are fractional

`tasks.position` is `numeric`, and dropping a card between two others writes
the midpoint of its neighbours — **one row**, not a renumbering of everything
below it. On a board two people are dragging at once, renumbering is how you
get an order neither of them chose. `move_task` does that arithmetic inside one
statement rather than in the browser, for the same reason.

### A login and a person are one click apart

An account and a roster row are two records on purpose (section 13). Crossing
between them used to be a four-step dance the OWNER had to do, while the
EMPLOYEE got nagged about it — the first version of the board told an account
with no roster row to "link it from Payroll → People", a page that needs
`payroll.write`, which that account does not have. **It told somebody to fix a
gap they are not allowed to touch, that somebody else left.**

Three changes, in the order they matter:

1. **The link makes itself.** A new `staff` row adopts the `employees` row
   carrying the same email, case and whitespace ignored. The ordinary sequence
   is join → payroll → account, and in that sequence the link is not a decision
   anybody needs to make. It picks exactly ONE row — the oldest match — and
   only when the account has nobody yet: `employees.user_id` is unique, so two
   roster rows sharing an address would otherwise abort the whole staff insert
   with a constraint error nobody could read.
2. **The staff list says who has nobody behind them**, and offers the one
   click. That is the screen where the role was granted, so it is the screen
   where the consequence belongs. The row is created bare — a name, an email,
   a link, no wage — because being on the roster is about doing work, and pay
   is a separate decision on a separate screen.
3. **The board's message is rewritten by who is reading it.** A manager is
   told nothing (the Start button needs a roster row and is simply not
   offered). Somebody who can fix it is told where. Somebody who cannot is
   told the fact and who to ask, and never sent to a page that would refuse
   them.

`v_staff.employee_id` comes through `app.employee_id_for()` — SECURITY
DEFINER, because `employees` is gated on `payroll.read` and this question is
asked from the staff screen by somebody who may hold nothing about salaries.
What it returns is an id, not a wage.

### The board is somebody's whole app

Somebody given `tasks.*` and nothing else sees one sidebar group, one screen,
and no overview — `/` needs `overview.read`, so `firstAllowedPath` lands them
on `/tasks`. For that person the board IS the product, and three empty columns
with no context reads as a corner of somebody else's system.

So the board opens with **their own day**: a greeting, four figures — open,
overdue, finished this week, and hours today against their own target — and
the running clock. Shown to everybody, not only to restricted accounts: a
screen that changes shape depending on your role is a screen nobody can be
told how to use.

Three details that only matter for restricted accounts, and all three were
wrong first time:

- **Tasks is its own sidebar group** (`الشغل`), not filed under `الأكاديمية`.
  For the owner that is tidiness; for a salesperson it is the whole sidebar.
- **The "link your account" notice is not shown to managers.** It is a
  setup warning for somebody who is meant to be timing work. A manager watches
  the team and may have no payroll row at all; telling them daily that their
  timer will not run is nagging about something they never asked for. The
  Start button needs an employee row and simply is not offered without one.
- **The Team tab is absent, not disabled**, for anybody without `team.read` —
  a tab that bounces you is worse than no tab.

Granting oversight to somebody else is one role edit: Staff → the role →
**متابعة الفريق**, which holds `team.read` (see everybody's board and the
productivity table) and `team.write` (assign work, approve time).

### What is deliberately not built

The reference product (PeakTime) also takes **automatic screenshots** of
employees' screens and logs **every website and application** they use. Neither
is here, and neither is a small omission:

- Both need a **desktop agent installed on each machine** with screen-recording
  permission. That is a signed native app per platform, not a page in this
  dashboard — no web app can capture the screen of a machine it is not running
  on.
- Continuous screen capture and app logging carry consent and notice
  obligations that vary by jurisdiction, and they collect far more than work
  data — the reference product's own UI has a "delete this screenshot if it
  contains personal content" button, which tells you what it captures.

The productivity numbers here come from work: hours against tasks, tasks
finished, what is overdue, and who is carrying what. If screen monitoring is
wanted later it is a separate product decision and a separate build, not an
extension of this one.
