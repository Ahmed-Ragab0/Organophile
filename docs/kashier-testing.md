# Testing a payment end to end

Two questions this document answers:

1. How do I make a payment happen without spending real money?
2. How do I settle the one open assumption in the schema — that ukkera's
   `order_id` is what Kashier returns as `merchantOrderId`?

They have the same answer, which is why they share a page.

---

## 1. Kashier's test cards

Kashier publishes test cards for test mode. They are on
<https://developers.kashier.io/payment/testing>, reproduced here so the
procedure below is self-contained.

| Type | Number | Cardholder |
|---|---|---|
| MasterCard | `5111111111111118` | Michel Doe |
| MasterCard | `5123456789012346` | John Doe |
| MasterCard (3-D Secure) | `5123450000000008` | John Doe |
| Visa | `4012000033330026` | John Doe |
| Visa (3-D Secure) | `4508750015741019` | John Doe |

**The expiry date chooses the outcome.** This is the part worth knowing: you
are not limited to testing the happy path, and you should not be — a decline
that is never exercised is a decline that fails for the first time in front of
a real student.

| Expiry | Result |
|---|---|
| `06/25` | APPROVED |
| `05/25` | DECLINED |
| `04/27` | EXPIRED_CARD |
| `08/28` | TIMED_OUT |
| `01/37` | ACQUIRER_SYSTEM_ERROR |
| `02/37` | UNSPECIFIED_FAILURE |
| `05/37` | UNKNOWN |

The CVV chooses the verification result: `100` MATCH, `101` NOT_PROCESSED,
`102` NO_MATCH.

Mobile wallet: Vodafone `01001001001`.

These cards work **only against test keys**. Against live keys they are
declined by the acquirer, as they should be.

> If the checkout form rejects `06/25` as already expired before it ever
> reaches Kashier, the published matrix has aged. Ask Kashier support for the
> current one rather than guessing — a card that declines for the wrong reason
> teaches you nothing.

---

## 2. What a test card can and cannot settle

A test card proves the machinery: webhook received, signature verified,
payment row written, ledger entry created, `is_test` set so it stays out of
the real books.

It does **not** settle the `merchantOrderId` question, unless the payment goes
through **ukkera's own checkout in ukkera's test mode**. The assumption is
about what ukkera puts in that field. A payment you create yourself against
Kashier directly carries an order id *you* chose, so it will match by
construction and tell you nothing.

So:

- **ukkera test checkout + Kashier test keys** → settles the question, costs
  nothing. This is the one to want.
- **Kashier test card, payment made directly** → exercises the plumbing only.
- **One small real purchase on live** → settles it beyond doubt. Costs the
  Kashier fee on a small amount and about two days for the payout to land.

If ukkera has no sandbox, the third is the honest answer, and the amount can
be small.

---

## 3. The procedure

1. Switch the dashboard to **test** with the mode switch in the top bar. The
   bar turns amber, so there is no confusing the two.
2. Register the test webhook (see [kashier-live-webhook.md](kashier-live-webhook.md);
   the steps are the same, with test keys).
3. Buy a course through ukkera's checkout, paying with a card from the table
   above and expiry `06/25`.
4. Watch it arrive:
   - **Payments** — a row appears with the transaction id.
   - **Subscriptions** — the order appears, if ukkera sent its webhook too.
   - **Reconciliation** — this is the one that matters. See below.
   - **Ledger** — an entry marked test, which must not appear in live totals.
5. Repeat with expiry `05/25` and confirm the decline is recorded as a failed
   attempt and does **not** create revenue.

---

## 4. Reading the answer: the match rate

**Reconciliation → Payment match rate.**

This panel exists to answer the open question, and it distinguishes three
states that a naive counter would blur together:

- **No evidence yet** — no live payment has arrived. Not a failure; nothing
  has been measured. This is what it says today.
- **Promising** — everything so far matched, but on too few payments to
  conclude anything. It shows the count against the threshold.
- **Assumption confirmed** — every live payment matched automatically, across
  enough transactions to mean something.
- **Some payments cannot find their order** — the assumption is false, at
  least sometimes. The unmatched payments are listed underneath and can be
  linked by hand.

It counts **live** settlement events only (`pay` and `capture`). Test payments
carry order ids we chose ourselves, so including them would inflate the rate
with evidence that proves nothing. Refunds and failed attempts are excluded
for the same reason: a refund not matching says nothing about the hypothesis.

---

## 5. If the rate is not 100%

The assumption is false for some payments. Nothing is lost — the design
anticipated this, which is why the link is a soft join and not a foreign key.
A wrong foreign key would have rejected the payment at ingest.

1. Open one unmatched payment and look at what `merchantOrderId` actually
   contains. The raw payload is stored, so the real value is always
   recoverable.
2. Link it by hand on the Reconciliation page. An override always beats the
   automatic join, so the fix is permanent for that payment.
3. If a **pattern** appears — a prefix, a suffix, a different field carrying
   the id — that is worth a migration to `app.normalize_order_id`, so the
   remaining payments match automatically instead of one at a time.

Until then, manual linking is correct rather than a workaround: it records a
human decision about a specific payment, with a reason attached.


---

## 6. What the first real payment actually showed (8 Sep 2026)

TX-4809032148, 100 EGP, Visa, live. Worth recording, because it settled the
open question and turned up a second problem that had nothing to do with it.

### The Kashier side worked completely

Webhook received and signature verified, payment row written, fees captured
(3.65 + 0.51 VAT, settling 95.84), ledger entry created against the Kashier
wallet and correctly marked live rather than test. Nothing to fix.

### merchantOrderId is not an order id

```
merchantOrderId : "transfer-+201117428440-1788870390057"
```

That is `transfer-<payer phone>-<epoch ms>` — a display string, carrying the
payer's phone number. ukkera's real identifier was one level down, base64
encoded:

```json
{ "transfer_id": 459,
  "account": { "name": "…", "email": "…", "phone": "+20…" },
  "custom_gateway_instructor_id": 175 }
```

`app.ukkera_meta()` decodes it on ingest. The join now runs on `transfer_id`,
which `app.project_ukkera_event` already reads from ukkera's own payload — so
the two sides did line up all along; the value was simply never extracted from
the Kashier side.

### ukkera never called

`ukkera_events_raw` was empty, and no rejected attempt was logged either — not
a bad token, not a malformed body, nothing. ukkera did not attempt the call at
all, which means the webhook is not registered on their side.

Until it is, `app.derive_order_from_payment` builds the student and the order
from the metaData, marked `source = 'kashier_metadata'` so the provenance is
never mistaken for an ukkera delivery. It creates only what is missing and
stops the moment an order exists, so ukkera remains the system of record the
day it starts speaking. What it cannot supply is **what was bought** — course
and package stay null, and the pricing page flags the order as unpriced.

To register it, ukkera needs:

```
URL     https://<project>.supabase.co/functions/v1/ukkera-webhook
Header  Authorization: Bearer <UKKERA_WEBHOOK_TOKEN>
```

### A regression this nearly shipped

Redefining `app.project_kashier_transaction` from 0004's copy of the body
silently dropped the `app.sync_payment_to_ledger` call that 0015 had added
directly in the database. Every future payment would have arrived with no
ledger entry, and nothing would have failed loudly.

The lesson is in the file now: when a function has been redefined in the
database, patch the definition you read back from `pg_get_functiondef`, not
the copy in an older migration.
