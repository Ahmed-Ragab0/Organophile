# Registering the Kashier **live** webhook

Status as of 2026-09-07: **not registered.** Only test mode is. Every row in
`kashier_events_raw` is `mode = 'test'`, so no real payment has ever reached
this system.

Do this **before the first real payment**. A payment that arrives with no
webhook registered is not queued anywhere — Kashier has nowhere to deliver it,
and the only record will be in Kashier's own dashboard.

---

## What you are registering

| Field | Value |
|---|---|
| URL | `https://egaaigoplqinjvwtnhoo.supabase.co/functions/v1/kashier-webhook?mode=live` |
| Method | POST (Kashier's default) |
| Events | `pay`, `refund`, `void`, `reversal` |

Add `capture` and `authorize` only if you actually use authorize-then-capture.
You do not today.

`?mode=live` is technically optional — the endpoint can work out the mode from
whichever key verifies the signature — but pinning it removes the ambiguity and
makes the raw event rows self-describing.

**Register transactions only.** Do not register a transfer webhook: this
account sends transfer deliveries with no `x-kashier-signature` header at all,
so they are correctly refused. Payouts come from `kashier-sync-payouts`
instead, which pulls them over TLS with your own Secret Key — better
provenance than an unsigned inbound POST.

---

## Before you touch the Kashier dashboard

**1. The live Payment API key must be in Supabase secrets.**

Supabase → Project Settings → Edge Functions → Secrets →
`KASHIER_PAYMENT_API_KEY_LIVE`.

This account holds **two** live Payment API keys — `Default-Live-Key` and one
named `يوكيرا` — and Kashier signs each webhook with whichever key created that
order. The variable is a **comma-separated list**; list both:

```
KASHIER_PAYMENT_API_KEY_LIVE = <Default-Live-Key>,<يوكيرا key>
```

Miss one and roughly half your live payments will be refused with
`signature_mismatch`.

Use the **Payment API Key** (the UUID under Developers → Integrations), not the
Merchant Secret Key — that one is for REST calls to `api.kashier.io` and lives
in `KASHIER_SECRET_KEY_LIVE`.

**2. Confirm the endpoint is reachable and still refuses forgeries.**

```bash
curl -i -X POST 'https://egaaigoplqinjvwtnhoo.supabase.co/functions/v1/kashier-webhook?mode=live' \
  -H 'content-type: application/json' -d '{"event":"pay"}'
```

Expect **401** and `{"error":"unauthorized"}`. A 401 here is the endpoint
working: an unsigned POST must never be accepted. If you get a 404 or 5xx,
stop — the function is not deployed.

---

## Register it

Kashier dashboard → **Developers → Integrations → Webhooks**, with the
dashboard switched to **live** mode.

1. Add a webhook with the URL above.
2. Select `pay`, `refund`, `void`, `reversal`.
3. Save, then press **Test**.

---

## Verify, in this order

**A. The delivery arrived and verified.**

```sql
select received_at, mode, event, resource_type, state, signature_valid, signature_note
from public.kashier_events_raw
where mode = 'live'
order by received_at desc limit 5;
```

You want `signature_valid = true` and a `signature_note` of `payment:live` (or
`payment:live#2` if the second key matched — that tells you which channel the
order came through).

**B. Nothing was refused.**

```sql
select received_at, endpoint, reason, detail
from public.webhook_rejections
order by received_at desc limit 10;
```

| `reason` | What it means | Fix |
|---|---|---|
| `no_api_keys_configured` | `KASHIER_PAYMENT_API_KEY_LIVE` is unset | Set it, redeploy is not needed |
| `signature_mismatch` | Wrong key, or only one of the two keys is listed | Add the missing key to the comma-separated list |
| `missing_signature_header` | Not from Kashier, or a transfer webhook you should not have registered | Remove the transfer webhook |
| `no_signature_keys_in_payload` | Payload carries no `signatureKeys` | Cannot be verified; raise with Kashier support |

**C. Nothing failed to project.**

```sql
select * from public.v_ingest_health;
```

A non-zero `failed` count is a projection bug, not an ingestion one — the
delivery is safely stored and the sweeper retries every 5 minutes. Force it
from the Health page, or `select app.sweep_failed_events();`.

---

## On the first real payment

This is the one open question the design was built around: whether ukkera's
`transfer_id` is the same string as Kashier's `merchantOrderId`. The link
between a payment and a subscription is a soft join precisely because a wrong
foreign key would have rejected real money at ingest.

```sql
select p.transaction_id, p.merchant_order_id, p.amount, p.status,
       s.order_id, m.match_method
from public.payments p
join public.v_payment_matches m on m.payment_id = p.id
left join public.subscriptions s on s.id = m.subscription_id
where p.mode = 'live'
order by p.transaction_date desc limit 5;
```

- `match_method = 'auto_order_key'` → the hypothesis holds. Nothing to do.
- `match_method = 'none'` → it does not. **The money is still recorded
  correctly** — it just is not attached to a subscription. Link it by hand on
  the Reconciliation page, and the join can be revisited with a real example in
  front of you.

Then confirm the money actually landed:

```sql
select * from public.v_wallet_balances where is_kashier_default;
select * from public.v_dashboard_kpis;
```

---

## Keeping Replit alive through the cutover

Leave the old Replit webhook running for 24–48 hours after registering this
one. Both systems receiving the same traffic is harmless: ingestion is
idempotent, deduped on a hash of the request body. Retire Replit once
`unmatched_payments` has sat at zero for a few days.
