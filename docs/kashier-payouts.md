# Payouts: how you get paid, and how to check

Answers "how much does Kashier owe me, has it been transferred, and how do I
prove it" — plus how to test the whole thing on test mode before trusting it
with real money.

Status as of 2026-09-08: **the sync has never run successfully.** It fails with
`no_secret_key_for_mode` because `KASHIER_SECRET_KEY_LIVE` is not set in
Supabase. Everything else is built and tested. Section 3 is the fix.

---

## 1. The model

Money does not go from a student to your bank in one step. It goes:

```
student pays
   → Kashier holds it            (settlement period)
   → Kashier keeps its fee
   → Kashier transfers the rest  (a "payout" / "transfer")
   → your bank account
```

So at any moment there are **three** different numbers, and calling all of them
"revenue" is how a month stops reconciling:

| Number | Meaning | Where it comes from |
|---|---|---|
| **Gross** | what students were charged | `payments.amount` |
| **Net settled** | gross − refunds − Kashier's fees: what Kashier *owes* you | `payments.settled_amount`, `payments.fees` |
| **Transferred** | what Kashier has actually *sent* | `payouts.amount` where the state is `TRANSFERRED` |

and therefore:

```
still at Kashier = net settled − transferred − in flight
```

That subtraction is exactly what the **موقف الفلوس** panel renders, on both the
Payouts page and Reports. Beside it sits Kashier's own answer
(`kashier_account.available_balance`, pulled from `/v2/account`). **If the two
disagree, something was missed** — a transaction that never arrived, or a
transfer we do not know about. The panel says "مطابق" or shows the gap.

### Why payouts are pulled, not pushed

Kashier can send transfer webhooks. For this merchant account it sends them
**with no `x-kashier-signature` header at all**, so they cannot be verified and
are correctly refused — you will see them in `webhook_rejections` as
`missing_signature_header`.

So payout tracking runs the other way round: `kashier-sync-payouts` makes a GET
to Kashier authenticated with your own Merchant Secret Key over TLS. That is
strictly **better** provenance than an unsigned inbound POST, and it does not
depend on Kashier enabling transfer signing.

```
POST …/functions/v1/kashier-sync-payouts?mode=live
   → GET https://api.kashier.io/v2/account            → kashier_account
   → GET https://api.kashier.io/v2/transfers?page=…   → payouts
```

Rows land through the same projection the webhook would have used, so a webhook
and a sync for the same transfer converge on one row and the state can only
move forward.

### Per-payment attribution is an estimate

The Payout API gives a transfer an **amount and a date, and no list of the
transactions it covered.** So "was *this student's* 1,200 EGP paid out?" cannot
be looked up — it can only be inferred.

`v_payment_payout_status` infers it FIFO: settlements are paid out oldest
first, so once the running total transferred passes a payment's place in the
queue, that payment's money has left Kashier. This is **exact in aggregate**
and ambiguous only for the one payment straddling a transfer boundary, which is
labelled `partially_paid_out` rather than guessed at. The Journey page marks
the whole column "تقديري".

---

## 2. Where to look

| Question | Page |
|---|---|
| How much is Kashier holding right now? | التحويلات → موقف الفلوس → "لسه عند كاشير" |
| Does Kashier agree? | the same panel → "رصيد كاشير المعلن" and the difference |
| Which transfers have I received? | التحويلات → the table |
| Did *this student's* money reach me? | رحلة الطلب → the "وصل حسابك" column |
| Why is a number off? | التقارير → موقف الفلوس, then المطابقة |

---

## 3. Fixing the sync (do this first)

The error in the UI is:

```
400 {"error":"no_secret_key_for_mode"}
```

It means the function had no key to call Kashier with, so **no request to
Kashier was made at all**. Nothing is broken upstream.

**Get the key.** Kashier dashboard → Developers → API Keys → **Merchant Secret
Key**. This is *not* the Payment API Key:

| Key | Used for | Supabase variable |
|---|---|---|
| Payment API Key (UUID) | verifying webhook signatures | `KASHIER_PAYMENT_API_KEY_LIVE` / `_TEST` |
| **Merchant Secret Key** | REST calls to `api.kashier.io` | **`KASHIER_SECRET_KEY_LIVE` / `_TEST`** |

**Set it.** Supabase → Project Settings → Edge Functions → Secrets → add:

- `KASHIER_SECRET_KEY_TEST` — the test-mode Secret Key
- `KASHIER_SECRET_KEY_LIVE` — the live-mode Secret Key

No redeploy is needed; secrets are read per invocation.

---

## 4. Testing it — test mode first

**1. Switch the top bar to تجريبي.** The bar turns amber. Every table on the
page is now test-only.

**2. Press تحديث من كاشير.**

| What you see | What it means |
|---|---|
| `المزامنة تمت — جه من كاشير: N · جديد: M` | working |
| the missing-key message | `KASHIER_SECRET_KEY_TEST` is not set |
| `401` | you are not signed in as an admin |
| `TypeError: Failed to fetch` | CORS — add your dashboard origin to `DASHBOARD_ORIGINS` |

**3. Confirm it landed.**

```sql
select mode, merchant_name, available_balance, last_transfer, synced_at
from public.kashier_account;

select mode, event, count(*), sum(amount)
from public.payouts group by 1, 2 order by 1, 2;
```

`synced_at` filling in is what turns "لم تتم المزامنة" into a timestamp on the
page. It says "not synced yet" because it never has been — that is a truthful
empty state, not a bug.

**4. Check the arithmetic.**

```sql
select * from public.v_money_position order by mode;
```

On a fresh test account with seeded transfers and no matching payments,
`awaiting_payout` will be **negative**. That is correct arithmetic on synthetic
data, not a fault — test-mode payouts exist with no test-mode payments behind
them.

**5. Run it twice.** The second run should report `duplicates` and add nothing.
Ingestion is idempotent — deduped on a hash of the transfer's identity and
state — so re-syncing is always safe.

## 5. Then live

Same steps with the switch on **مباشر**, once `KASHIER_SECRET_KEY_LIVE` is set.

What "correct" looks like on live:

```sql
select
  net_settled,               -- what Kashier owes you
  transferred,               -- what it has sent
  awaiting_payout,           -- our answer to "still at Kashier"
  kashier_reported_balance,  -- Kashier's answer
  kashier_reported_balance - awaiting_payout as gap
from public.v_money_position where mode = 'live';
```

`gap` near zero means the two systems agree and the books are trustworthy. A
real gap means one of:

- a payment webhook never arrived → check المطابقة and `webhook_rejections`
- a transfer we have not synced → press تحديث من كاشير again
- a refund Kashier processed that we did not record

**Note on timing:** Kashier settles on its own schedule, so `awaiting_payout`
being non-zero is normal and expected — that is money you have earned that has
not been transferred yet, not money that is missing.

---

## 6. Automating it

The sync is safe to run on a schedule; it is idempotent and cheap. It accepts
the service role key so cron can call it:

```sql
select cron.schedule(
  'kashier-sync-payouts-daily',
  '0 6 * * *',
  $$
  select net.http_post(
    url := 'https://egaaigoplqinjvwtnhoo.supabase.co/functions/v1/kashier-sync-payouts?mode=live',
    headers := jsonb_build_object('authorization', 'Bearer ' || current_setting('app.service_role_key'))
  );
  $$
);
```

Not scheduled yet — turn it on once a live sync has succeeded by hand.
