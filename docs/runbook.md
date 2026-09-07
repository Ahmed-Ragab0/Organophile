# Runbook

Project ref: `egaaigoplqinjvwtnhoo` · Base: `https://egaaigoplqinjvwtnhoo.supabase.co`

## Endpoints

| Purpose | URL |
|---|---|
| Kashier, test mode | `…/functions/v1/kashier-webhook?mode=test` |
| Kashier, live mode | `…/functions/v1/kashier-webhook?mode=live` |
| Kashier per-order `serverWebhook` | `…/functions/v1/kashier-webhook?mode=live&source=server` |
| ukkera | `…/functions/v1/ukkera-webhook` |

`?mode=` is optional — the endpoint can infer the mode from whichever key
verifies — but pinning it removes all ambiguity and is recommended.

## 1. Secrets

Supabase → Project Settings → Edge Functions → Secrets:

| Name | Value |
|---|---|
| `KASHIER_PAYMENT_API_KEY_TEST` | Payment API key(s), test mode |
| `KASHIER_PAYMENT_API_KEY_LIVE` | Payment API key(s), live mode |
| `KASHIER_TRANSFER_API_KEY_TEST` | Transfer API key, test (if you have one) |
| `KASHIER_TRANSFER_API_KEY_LIVE` | Transfer API key, live (if you have one) |
| `UKKERA_WEBHOOK_TOKEN` | The generated token in `.secrets/SETUP-SECRETS.md` |
| `DASHBOARD_ORIGINS` | Comma-separated browser origins allowed to call `kashier-sync-payouts` (the Vercel URL). localhost is always allowed. |

**Every Kashier variable accepts a comma-separated list.** A merchant can hold
several Payment API keys (this account has `Default-Live-Key` and one named
`يوكيرا`), and Kashier signs each webhook with whichever key created that
order — so list them all:

```
KASHIER_PAYMENT_API_KEY_LIVE = 306dfdce-...,e258efa9-...
```

Use the **Payment API Key** (the UUID from Developers → Integrations), not the
"Secret Key" used for REST calls to `api.kashier.io`. The endpoint tries every
configured key and records which one matched in
`kashier_events_raw.signature_note`, so you can see at a glance which channel a
payment came through.

### The ukkera header

ukkera's webhook screen calls these "معطيات الوصول (Headers)". The header **name**
must be exactly `Authorization` — naming it after the secret (e.g.
`UKKERA_WEBHOOK_TOKEN`) sends no `Authorization` header at all and the endpoint
answers 401 with reason `missing_bearer_token`.

| Field | Value |
|---|---|
| Name | `Authorization` |
| Value | `Bearer ukk_…` (a bare token without the `Bearer ` prefix is also accepted) |

`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are injected automatically.

`KASHIER_ALLOW_UNVERIFIED` exists but **must stay unset**. It accepts
unverified deliveries and is only ever for local debugging.

## 2. The owner account

1. Supabase → Authentication → Users → **Add user**, with "Auto Confirm" on.
2. Grant admin:

```sql
insert into public.admin_users (user_id, email)
select id, email from auth.users where email = 'you@example.com'
on conflict (user_id) do nothing;
```

3. Turn **off** public sign-ups: Authentication → Providers → Email →
   disable "Enable sign ups". There is exactly one user; anyone else signing up
   would get an account with no access, but there is no reason to allow it.

Without a row in `admin_users`, a signed-in user sees nothing at all — RLS
returns zero rows and the proxy bounces them to `/login?denied=1`.

## 3. Register the webhooks

> Going live with real payments has its own checklist, including the two live
> Payment API keys that must both be listed:
> [`kashier-live-webhook.md`](kashier-live-webhook.md).

Kashier dashboard → Developers → Integrations → Webhooks. Register **two**
separate webhooks rather than one covering both resource types — that avoids
the combined test envelope entirely.

| Webhook | Events |
|---|---|
| Transactions | `pay`, `refund`, `void`, `reversal` (add `capture`/`authorize` only if you use authorize-then-capture) |
| Transfers | `INITIATED`, `TRANSFERRED`, `FAILED` |

Start in **test mode**. Press **Test** and confirm:

```sql
select event, resource_type, state, signature_valid, signature_note, received_at
from public.kashier_events_raw order by received_at desc limit 5;
```

`signature_valid = true` and a `signature_note` like `payment:test` means the
key is right. If instead a row appears in `webhook_rejections`, read `reason`:

| Reason | Meaning |
|---|---|
| `no_api_keys_configured` | The secret for that mode/type is not set |
| `signature_mismatch` | Wrong key, or the wrong one of payment/transfer |
| `missing_signature_header` | Not actually from Kashier |
| `no_signature_keys_in_payload` | Payload has no `signatureKeys` — cannot be verified |

## 4. Cut over from Replit

The current Replit webhook is **live and receiving real payments**. Order matters.

1. Test the new ukkera endpoint *before* touching ukkera's settings:

```bash
curl -i -X POST 'https://egaaigoplqinjvwtnhoo.supabase.co/functions/v1/ukkera-webhook' \
  -H 'authorization: Bearer <UKKERA_WEBHOOK_TOKEN>' \
  -H 'content-type: application/json' \
  -d '{"student_name":"اختبار","phone":"01012345678","course":"Test",
       "amount":1,"order_id":"CUTOVER-TEST-1","payment_date":"2026-09-07"}'
```

Expect `200` and `{"processing":"processed"}`. Then confirm the row:

```sql
select * from public.subscriptions where order_id = 'CUTOVER-TEST-1';
```

Delete it afterwards.

2. Switch ukkera's webhook URL and token to the new endpoint.
3. **Leave Replit running for 24–48 hours.** Both systems receiving the same
   traffic is harmless — ingestion is idempotent.
4. Register the Kashier **live** webhooks.
5. On the first real payment, verify the linking hypothesis:

```sql
select p.transaction_id, p.merchant_order_id, s.order_id, m.match_method
from public.payments p
join public.v_payment_matches m on m.payment_id = p.id
left join public.subscriptions s on s.id = m.subscription_id
where p.mode = 'live' order by p.transaction_date desc limit 5;
```

`match_method = 'auto_order_key'` confirms `order_id == merchantOrderId`. If it
says `none`, the assumption is wrong — the payments are still safe, they just
need linking on the Reconciliation page while the join is revisited.

6. Once a few days pass with `unmatched_payments` at zero, retire Replit.

## 5. Operations

**"I never got the webhook"** — Health page, or:

```sql
select * from public.v_ingest_health;
select received_at, event, state, process_error
from public.kashier_events_raw where state = 'failed' order by received_at desc;
select * from public.webhook_rejections order by received_at desc limit 20;
```

**After fixing a projection bug** — the sweeper runs every 5 minutes on its
own. To force it: the **Reprocess failed** button on the Health page, or
`select app.sweep_failed_events();`.

**Reprocess a row that exceeded 12 attempts**:

```sql
update public.kashier_events_raw set state = 'pending', process_attempts = 0
where id = '<uuid>';
```

**Rotate the ukkera token** — set the new value in Supabase secrets and ukkera
together. Rejected calls land in `webhook_rejections` as `bad_bearer_token`.

**Check the scheduled jobs**:

```sql
select jobname, schedule, active from cron.job;
select jobname, status, start_time from cron.job_run_details
order by start_time desc limit 10;
```

## 6. Deploying

Edge Functions (Supabase CLI linked to this project):

```bash
supabase functions deploy kashier-webhook      --no-verify-jwt
supabase functions deploy ukkera-webhook       --no-verify-jwt
supabase functions deploy kashier-sync-payouts --no-verify-jwt
```

`--no-verify-jwt` is required: neither Kashier nor ukkera can present a
Supabase JWT. Both functions authenticate their callers themselves.

Dashboard → Vercel, root directory `web`, with
`NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_ANON_KEY` set.
Never add the service role key there.
