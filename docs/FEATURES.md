# What this system does

**Read this to understand the product.** `PROJECT.md` is the architecture and
the rules; this is the feature map — every page, what it answers, where its
numbers come from, and what is wired to what.

Keep it current. When a page changes, change the section for it here in the
same commit.

Last updated: 2026-09-08

---

## 1. In one paragraph

Organophile is the management system for an Egyptian organic-chemistry tutoring
business. Students buy courses on **ukkera** (the LMS) and pay through
**Kashier** (the payment gateway). Both push webhooks here. The system verifies
them, stores the raw delivery, projects it into a domain model, and turns the
result into one picture: who your students are, what they owe, what they paid,
what Kashier is still holding, and what has reached your bank.

Nothing here is a copy of a spreadsheet. Every figure is derived from a
verified delivery or a deliberate manual entry, and every figure can be traced
back to the row it came from.

---

## 2. The three systems, and who owns what

| System | Owns | Reaches us by |
|---|---|---|
| **ukkera** | Students, courses, packages, enrolments | Webhook → `ukkera-webhook` |
| **Kashier** | Transactions, fees, settlement, payouts | Webhook → `kashier-webhook`, plus a REST pull → `kashier-sync-payouts` |
| **This system** | Prices, instalment plans, expenses, wallets, the ledger | Written here, by you |

The division matters: **ukkera data is roster information and never creates or
changes money.** A student appearing is not a payment. Only a signature-verified
Kashier webhook — or a deliberate manual entry you make — moves a number.

---

## 3. The chain

```
   ukkera                Kashier                    You
     │                      │                        │
  enrolment             payment                  a price
     │                      │                        │
     ▼                      ▼                        ▼
subscription  ◄── soft join ── payment           total_due
     │                      │                        │
     │                      ├─► ledger entry ◄───────┘
     │                      │        │
     │                      │        ▼
     │                      │     wallet balance
     │                      │
     │                      └─► payout ──► your bank
     ▼
  journey row  ── ordered? paid? banked? ──► the Journey page
```

The one join that is **not** a foreign key is subscription ↔ payment. It is
matched on `order_key` (ukkera's `transfer_id` against Kashier's
`merchantOrderId`), with a manual override table beside it. That is deliberate:
a wrong foreign key would reject real money at ingest, while a wrong soft join
only shows up as a row on the Reconciliation page.

---

## 4. Appearance

The top bar carries a theme button beside the language one, cycling
**follow the system → light → dark**. The choice is a cookie, rendered on the
server as `data-theme` on `<html>`, so the first paint is already the right
colour — a theme applied by JS after hydration flashes white, which on a dark
dashboard at night is unpleasant.

The palette is declared once per token as `light-dark(light, dark)`, and the
button only changes `color-scheme`. That means native controls, scrollbars and
date pickers follow the theme too, which a class-based dark mode always gets
wrong. The browser's own chrome colour follows the pinned theme as well, via
`generateViewport` reading the same cookie.

---

## 5. Test and live

Kashier runs two parallel worlds with separate keys, ids and balances. The
**mode switch in the top bar** decides which one you are looking at, and it is
remembered in a cookie. Test mode tints the top bar amber so you can never
mistake one for the other.

The switch filters what you **see**: payments, transfers, the ledger, ingest
health, reconciliation, the journey.

It deliberately cannot change what **counts**. Wallet balances, profit and the
reports exclude test traffic in the database itself — that is the invariant
that keeps `sum(wallet balances) = opening + revenue − expenses` true. Money
pages say so in a banner rather than silently ignoring the switch.

There are two independent "this is test" signals and either one is enough:

- `mode = 'test'` — the delivery arrived on the test endpoint / test key.
- `is_test_webhook` — Kashier's own flag, set when someone presses **Test** in
  the Kashier dashboard. That button posts to whichever URL it is aimed at,
  **including the live one**, which is how a synthetic 100 EGP once got booked
  as real revenue. Both signals are now honoured.

---

## 6. The pages

### نظرة عامة · Overview — `/`

The month, as a subtraction rather than three unrelated numbers.

- **Hero**: revenue and expenses as opposing bars either side of net profit.
- **Tiles**: outstanding, wallets total, active students, subscriptions.
- **This month**: revenue, expenses, net.
- **Wallet strip**: every account's balance, bar-scaled against the largest.
- **Charts**: revenue vs expenses, and net profit, over 30 days.
- **Kashier block**: available balance, in flight, received, last transfer.
- **Needs attention**: unmatched payments, unpaid subscriptions, failed ingest
  — each one a link to the page that fixes it.

Reads `v_dashboard_kpis`, `v_wallet_balances`, `v_finance_daily`,
`kashier_account`. All live-only.

### المحافظ · Wallets — `/wallets`

The six real accounts and what is in them. Money in, money out, entry count,
last movement. One wallet is flagged `is_kashier_default` — that is where
Kashier revenue lands. Actions: add expense, record revenue, transfer between
wallets.

Reads `v_wallet_balances`. Writes go through `add_expense`,
`add_manual_revenue`, `transfer_between_wallets` — never a direct insert.

### دفتر العمليات · Ledger — `/ledger`

The single source of truth, filterable by type, wallet, date and text. Every
row shows its wallet effect, its P&L effect, and what it is attached to
(student, course, subscription, Kashier transaction). Entries can be **voided,
never deleted**; voiding one half of a transfer voids both.

Reads `v_ledger`, filtered by the mode switch via `is_test`.

### المصروفات · Expenses — `/expenses`

Spending by category, with the same add/void discipline as the ledger.

Reads `v_expenses_by_category` and `v_ledger`.

### التقارير · Reports — `/reports`

Two kinds of question, deliberately kept apart:

**BALANCE — "where is my money right now"**, which has no period. The money
position chain (collected → minus refunds → minus Kashier fees → **minus bank
fees** → net owed to you → minus transferred → minus in flight → **still at
Kashier**), Kashier's own reported balance beside it, and the difference.

The chain is now: collected → minus refunds → minus Kashier's fee → minus the
14% VAT on that fee → minus the flat bank fee → **net revenue**.

Each deduction is its own line because each has a different source. Kashier's
fee and its VAT arrive inside every payload and can be checked against the
transaction on Kashier's dashboard; the bank fee arrives on the *account*
endpoint as `payoutFees` and never on the transaction, so it is applied from
`kashier_fee_schedule`. Merging them would produce a figure that reconciles
against nothing.

Below the chain, Kashier's own answer is split into **available now** and
**held for settlement**. Reading `availableBalance` alone reports every recent
payment as a shortfall, because money inside the settlement window sits in
`onHoldBalance`. The notice distinguishes four cases: payments newer than the
snapshot (re-sync), the settlement window (normal), money missing for over
three days (investigate), and Kashier holding more than was ever recorded
(transactions that never reached the system). A gap is the first sign a
transaction or transfer was missed. Plus wallet balances.

**PERIOD — "what happened between these two months"**, over a month range with
presets (this month, last month, last 3, last 12, all time). The range is a
*month* range because every underlying view is keyed by month; a day picker
over month-granularity data would be a lie at the edges.

The **pressed preset is highlighted**, and the range is restated in words
underneath — two selects both reading "September" do not say "one month", and
a hand-picked range has no pressed button to speak for it, so it is labelled
"custom range" instead.

Totals for the range: revenue, expenses, net, Kashier fees, outstanding. Then
nine reports behind one picker, each exportable to CSV from the header button.
The export button carries the row count it would write, and when a report has
no rows in the range it says so rather than sitting disabled with no reason —
which reads as broken:

| Report | Reads |
|---|---|
| شهر بشهر | `v_monthly_report` |
| يوم بيوم | `v_finance_daily` |
| الكورسات | `v_revenue_by_course` |
| الجامعات | `v_revenue_by_university` |
| المصروفات | `v_expenses_by_category` |
| وسيلة الدفع | `v_revenue_by_method` |
| رسوم كاشير | `v_fees_monthly` — Kashier's reported fee and the unreported flat bank fee as separate columns, with both the headline and the effective rate |
| تحصيل الطلاب | `v_student_financials`, ranked by what is still owed |
| التحويلات | `v_payouts_monthly` |

Breakdowns that are stored per month are collapsed to one row per label across
the whole range, so "الكورسات" over a year is one row per course, not twelve.

Filtering happens in the database, not the browser, so a long history never has
to travel to the client.

### الطلاب · Students — `/students`

Every student with their financial status: total due, paid, remaining, payment
status, university, courses. Filterable by university, course, status, active,
registration date, and two mutually exclusive shortcuts (owes money / fully
paid). Exports to CSV with a UTF-8 BOM so Excel on Windows does not mangle
Arabic names.

Reads `search_students(...)`, which is the only SECURITY INVOKER routine in the
API — that is what keeps RLS applying to student rows.

`/students/[id]` gives one student's financial summary, their subscriptions and
their ledger entries.

### الكورسات · Courses — `/courses`

The catalogue with student counts and money per course, grouped by university.

Reads `v_course_catalogue`.

### الاشتراكات · Subscriptions — `/subscriptions`

Every order ukkera sent, with its money and its search.

- **One search box** across order id, student name, phone, course and package.
  A phone typed as `010…`, `+2010…` or with spaces all find the same student,
  because the query also tries the normalised column.
- **Filters**: course, package (narrowed to the chosen course, so the pair
  cannot be combined into a filter that returns nothing), payment status,
  price source, and an enrolment date range.
- **Active filters** are listed as removable chips under the controls. A row
  of selects tells you what you *could* filter by; the chips tell you what you
  *are* filtering by, which is the question you actually have when a list
  looks short.
- Totals above the table are for the filtered page, so narrowing a filter has
  a visible effect on money, not just on row count.

Reads `v_subscriptions_list`. All filtering happens in the database: the page
before this one searched only the order id and filtered the rest in the
browser over a capped page, so a match on row 501 did not exist.

### الأسعار والدفعات · Pricing & instalments — `/pricing`

Where an order gets a price and a payment plan.

ukkera says what a student bought, not what it should cost, and a package
arrives with no price at all. Without this page there is no outstanding
balance, because there is no figure to subtract what was paid from.

- **The rule, stated at the top.** Four numbered steps showing the precedence:
  a price set on the subscription, then the package price, then the amount
  ukkera sent, then nothing. The source badges in the table are meaningless
  without it — the reader can see that one row says "package" and another says
  "order", but not that the first beats the second.
- **One search above both tables**, covering package and course names as well
  as order id and student. "Needs a price" means the same thing in each — a
  package with no price, a subscription with nothing to fall back on — so the
  pair reads as one question: show me everything that still needs pricing.
- **Step 1 — package prices**, editable inline. Price a package once and every
  subscription in it follows. Stacked full width rather than squeezed into a
  sidebar, so the course, the pricing status and the number of subscriptions
  using each package all get their own column.
- **Step 2 — subscription prices**, for the orders that need to differ. Each
  row carries **where its price came from**.
- **Unpriced** is the one tile that is a task rather than a figure, so it is
  the only one you can press: it filters the table to exactly the rows it is
  counting.
- `/pricing/[id]` — price and terms, the instalment schedule (with "split
  evenly", which distributes to the piastre so the plan always sums to the
  price), and the payments actually received, with void.

Price resolution is `coalesce(subscription.total_due, package.price,
subscription.amount, 0)`. Clearing a price back to **null** returns it to the
package price; **zero is a different state** and the UI keeps them apart.

Reads `subscriptions`, `packages`, `v_subscription_financials`,
`subscription_installments`, `v_ledger`. Payments are recorded through
`add_manual_revenue`.

### رحلة الطلب · Order journey — `/journey`

**The page this system exists for.** One row per ukkera order carrying all
three stages:

| Stage | Question | Values |
|---|---|---|
| اشترى | did ukkera send us the order? | always yes if the row exists |
| دفع | did Kashier take money for it? | not paid · part paid · paid in full |
| وصل حسابك | has that money reached the bank? | no money · at Kashier · partly transferred · in your bank |

Plus the Kashier transaction id, the net after fees, and whether the payment
was linked to the order automatically, manually, or not at all.

Reads `v_order_journey`.

> **The payout stage is an estimate, and the page says so.** Kashier's Payout
> API gives a transfer an amount and a date and *no list of the transactions it
> covered*, so per-payment attribution is not a fact that can be looked up. It
> is inferred FIFO — settlements are paid out oldest first — which is exact in
> aggregate and ambiguous only for payments straddling a transfer boundary.
> Those are marked "partly transferred" rather than guessed at.

### المدفوعات · Payments — `/payments`

Every Kashier transaction: id, order, student, course, amount, settled, fees,
status, event, method, card, date, and how it was matched to a subscription.
Filtered by the mode switch.

Reads `v_payments_enriched`.

### التحويلات · Payouts — `/payouts`

What Kashier has actually sent you. Same money-position chain as Reports, then
transferred / in flight / still at Kashier / failed, then the transfer list.

The **تحديث من كاشير** button calls `kashier-sync-payouts`, which pulls
`/v2/account` and `/v2/transfers` from Kashier with your Merchant Secret Key.
See [`kashier-payouts.md`](kashier-payouts.md) for the whole model and how to
test it.

**Bank fee** is set here, beside the position it feeds. Kashier takes a flat
amount per transaction that it does not report in the payload, so this is the
one number in the accounts that comes from a person rather than the gateway,
and the panel says so.

The schedule is effective-dated: each payment is charged the rate in force on
its own transaction date, so correcting the fee today cannot restate a month
already reconciled. The effective-from date is editable and usually needs to
be — the schedule is seeded from the moment it was created, which is rarely
the moment the fee actually started.

Reads `v_money_position`, `payouts` and `kashier_fee_schedule`, all scoped to
the current mode.

### المطابقة · Reconciliation — `/reconciliation`

The two failure modes of the soft join, side by side:

- **Payments with no subscription** — money arrived that we cannot attribute.
- **Subscriptions with no payment** — an order nobody paid for.

You can link a payment to a subscription by hand; that writes
`payment_subscription_overrides`, which always wins over the automatic match.

**Payment match rate** measures the one open assumption in the schema — that
ukkera's `order_id` is what Kashier returns as `merchantOrderId`. It counts
live `pay`/`capture` events only, and distinguishes "no evidence yet" from
"0% matched", which look identical in a naive counter and mean opposite
things. See [kashier-testing.md](kashier-testing.md) for how to settle it.

Reads `v_unmatched_payments`, `v_unpaid_subscriptions`,
`v_payment_match_health`.

### استيراد · Import — `/import`

Bulk student import from a CSV export. Column headers are auto-detected from
Arabic and English aliases and can be remapped by hand, because ukkera's export
headers are still unknown. Goes through `import_students`, which dedupes on the
normalised phone number.

### حالة النظام · Health — `/health`

Ingestion, honestly reported: deliveries received, processed, failed, ignored;
the failed events with their error; and everything that was refused, with the
reason. A **reprocess** button forces the sweeper, which otherwise runs every
five minutes.

Reads `v_ingest_health`, `kashier_events_raw`, `webhook_rejections`.

---

## 7. Where the numbers come from

**Ingest, append-only**
`kashier_events_raw`, `ukkera_events_raw` — every delivery, deduped on a hash
of the request body, with a state machine (pending → processed / failed /
ignored). `webhook_rejections` — anything refused, with a 2 KB body excerpt.

**Domain**
`students`, `universities`, `courses`, `packages`, `subscriptions`,
`subscription_installments`, `payments`, `payouts`, `kashier_account`.

**Money**
`wallets` (six accounts, one flagged as the Kashier default) and
`ledger_entries` — the single source of truth. Amounts are always positive;
direction comes from `entry_type`.

**Views**

| View | Answers |
|---|---|
| `v_dashboard_kpis` | the overview in one row |
| `v_wallet_balances` | balance per wallet |
| `v_ledger` | every entry, enriched with names |
| `v_finance_daily` / `v_finance_monthly` / `v_monthly_report` | the P&L over time |
| `v_money_position` | **where the money is right now, per mode** |
| `v_payment_payout_status` | FIFO payout estimate per payment |
| `v_order_journey` | **the whole chain, one row per order** |
| `v_student_financials` / `v_subscription_financials` | due, paid, remaining, status |
| `v_payments_enriched` / `v_unmatched_payments` | payments with their match |
| `v_unpaid_subscriptions` | orders with no payment |
| `v_course_catalogue` / `v_revenue_by_course` / `v_revenue_by_university` | breakdowns |
| `v_expenses_by_category` | spending |
| `v_revenue_by_method` | revenue and fees per payment method |
| `v_fees_monthly` | what Kashier charged, and the effective rate |
| `v_payouts_monthly` | transfers per month and mode |
| `v_ingest_health` | webhook state |

**Functions the app calls**
`add_expense`, `add_manual_revenue`, `transfer_between_wallets`,
`void_ledger_entry`, `search_students`, `import_students`,
`reconcile_transactions`, `sweep_failed_events`, `normalize_phone`.

---

## 8. Rules that must not break

1. Money only ever comes from a signature-verified Kashier webhook, or a
   deliberate manual ledger entry.
2. Ingestion never throws — a non-2xx makes Kashier retry for ~23.5 hours.
3. Dedupe hashes the request body, not `(transaction_id, event)`.
4. Deliveries are unordered; a status can only move forward.
5. A payment and its wallet movement are written in the same transaction.
6. Nothing financial is deleted, only voided.
7. Test traffic is excluded from every money figure — by `mode` **and** by
   `is_test_webhook`.
8. Direct writes to `ledger_entries` are denied by RLS.

---

## 9. Not automated yet

- **Payout attribution per payment** is a FIFO estimate, not a fact from
  Kashier. See the Journey section.
- **Signed transfer webhooks** — Kashier sends transfer deliveries for this
  account with no signature header, so they are refused. Payouts come from the
  REST pull instead. A Transfer API Key from Kashier support would enable them.
- **The subscription ↔ payment join** is unconfirmed against real live traffic.
  Verify it on the first real payment; the Reconciliation page is the fallback.
- **The live Kashier webhook** is not registered yet. See
  [`kashier-live-webhook.md`](kashier-live-webhook.md).
