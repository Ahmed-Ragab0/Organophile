-- 0020_ukkera_metadata_link.sql
--
-- Settles the open question from 0002_core_schema line 6, and the answer is no.
--
-- The first real payment (TX-4809032148, 8 Sep 2026) came through ukkera and
-- carried this:
--
--   merchantOrderId : "transfer-+201117428440-1788870390057"
--   metaData.key    : "INSTRUCTOR_TRANSFER"
--   metaData.data   : <base64> -> {"transfer_id": 459,
--                                  "account": {"name","email","phone"}, ...}
--   referral url    : "https://organophile.ukkera.net/"
--
-- So merchantOrderId is NOT ukkera's order id. It is a display string ukkera
-- builds as `transfer-<phone>-<epoch_ms>`, and the phone in it belongs to the
-- payer, which makes it useless as a join key and unwise to keep treating as
-- one.
--
-- ukkera's real identifier — `transfer_id` — is inside the base64 metaData,
-- alongside the payer's name, email and phone. `app.project_ukkera_event`
-- already reads `transfer_id` as an order id candidate, so the two sides do
-- line up; the value was simply never being extracted from this side.
--
-- This migration extracts it, joins on it, and keeps the old merchantOrderId
-- join as a fallback rather than deleting it: nothing here proves ukkera uses
-- the same shape for every product it sells.

-- ---------------------------------------------------------------------------
-- The decoder
-- ---------------------------------------------------------------------------
-- Returns '{}' rather than raising on anything unexpected. This runs inside
-- the ingest path, and Kashier retries any non-2xx for about 23.5 hours — a
-- malformed metaData must never turn into a retry storm.

create or replace function app.ukkera_meta(p_payload jsonb)
returns jsonb
language plpgsql
immutable
parallel safe
set search_path = ''
as $$
declare
  v_raw    text := p_payload -> 'data' -> 'metaData' ->> 'data';
  v_padded text;
begin
  if v_raw is null or btrim(v_raw) = '' then
    return '{}'::jsonb;
  end if;

  -- Accept URL-safe base64 and restore padding: decode() rejects a length
  -- that is not a multiple of four, and senders routinely strip the '='.
  v_padded := replace(replace(btrim(v_raw), '-', '+'), '_', '/');
  v_padded := v_padded || repeat('=', (4 - (length(v_padded) % 4)) % 4);

  begin
    return convert_from(decode(v_padded, 'base64'), 'UTF8')::jsonb;
  exception when others then
    return '{}'::jsonb;
  end;
end;
$$;

comment on function app.ukkera_meta(jsonb) is
  'Decodes ukkera''s base64 metaData.data from a Kashier payload. Returns an '
  'empty object for anything it cannot read — never raises, because it runs '
  'inside ingest.';

-- ---------------------------------------------------------------------------
-- What the payment now carries
-- ---------------------------------------------------------------------------

alter table public.payments
  add column if not exists ukkera_transfer_id text,
  add column if not exists payer_name         text,
  add column if not exists payer_email        text,
  add column if not exists payer_phone        text;

alter table public.payments
  add column if not exists ukkera_transfer_key text
    generated always as (app.normalize_order_id(ukkera_transfer_id)) stored;

alter table public.payments
  add column if not exists payer_phone_normalized text
    generated always as (app.normalize_phone(payer_phone)) stored;

create index if not exists payments_ukkera_transfer_key_idx
  on public.payments (ukkera_transfer_key)
  where ukkera_transfer_key is not null;

create index if not exists payments_payer_phone_idx
  on public.payments (payer_phone_normalized)
  where payer_phone_normalized is not null;

comment on column public.payments.ukkera_transfer_id is
  'ukkera''s transfer_id, lifted out of the base64 metaData. This is the real '
  'join key to subscriptions.order_id — merchantOrderId is not.';
comment on column public.payments.payer_name is
  'Who actually paid, from ukkera''s metaData. Present even when ukkera''s own '
  'webhook never arrives, so money is never anonymous.';

-- ---------------------------------------------------------------------------
-- Extract on ingest
-- ---------------------------------------------------------------------------
-- Only the four new columns change; everything else is 0004 verbatim, so a
-- diff between the two shows exactly what this migration touched.

create or replace function app.project_kashier_transaction(p_raw public.kashier_events_raw)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  d           jsonb := coalesce(p_raw.payload -> 'data', '{}'::jsonb);
  v_txn_id    text  := nullif(btrim(coalesce(d ->> 'transactionId', '')), '');
  v_event     public.kashier_txn_event;
  v_status    public.txn_status := app.to_txn_status(d ->> 'status');
  v_card      jsonb := coalesce(d -> 'sourceOfFunds' -> 'cardInfo', d -> 'card' -> 'cardInfo', '{}'::jsonb);
  v_settle    jsonb := coalesce(d -> 'settlementInfo', '{}'::jsonb);
  v_meta      jsonb := app.ukkera_meta(p_raw.payload);
  v_acct      jsonb := coalesce(v_meta -> 'account', '{}'::jsonb);
  v_id        uuid;
begin
  if v_txn_id is null then
    raise exception 'IGNORE: transaction payload has no transactionId';
  end if;

  begin
    v_event := p_raw.event::public.kashier_txn_event;
  exception when others then
    raise exception 'IGNORE: unsupported transaction event %', coalesce(p_raw.event, '<null>');
  end;

  insert into public.payments (
    transaction_id, kashier_order_id, merchant_order_id, order_reference,
    event, status, mode,
    amount, currency, settled_amount, fees, vat,
    method, channel, card_brand, masked_card, card_holder_name, apikey_name,
    transaction_date, response_code, response_message,
    is_test_webhook, raw_payload,
    ukkera_transfer_id, payer_name, payer_email, payer_phone
  ) values (
    v_txn_id,
    d ->> 'kashierOrderId',
    d ->> 'merchantOrderId',
    d ->> 'orderReference',
    v_event,
    v_status,
    p_raw.mode,
    app.to_numeric(d ->> 'amount'),
    coalesce(d ->> 'currency', 'EGP'),
    app.to_numeric(v_settle ->> 'settledAmount'),
    app.to_numeric(v_settle ->> 'totalSellingFees'),
    app.to_numeric(v_settle ->> 'vat'),
    coalesce(d ->> 'method', d ->> 'paymentMethod'),
    d ->> 'channel',
    v_card ->> 'cardBrand',
    v_card ->> 'maskedCard',
    v_card ->> 'cardHolderName',
    d ->> 'apikeyname',
    app.to_timestamptz(d ->> 'creationDate'),
    d ->> 'transactionResponseCode',
    coalesce(d -> 'transactionResponseMessage' ->> 'en', d ->> 'transactionResponseMessage'),
    coalesce((d ->> 'isTestWebhook')::boolean, false),
    p_raw.payload,
    -- transfer_id arrives as a JSON number; the column is text because every
    -- other order identifier in this system is.
    nullif(btrim(coalesce(v_meta ->> 'transfer_id', '')), ''),
    nullif(btrim(coalesce(v_acct ->> 'name', '')), ''),
    nullif(btrim(coalesce(v_acct ->> 'email', '')), ''),
    nullif(btrim(coalesce(v_acct ->> 'phone', '')), '')
  )
  on conflict (transaction_id, mode) do update set
    status = case
               when app.status_rank(excluded.status) >= app.status_rank(public.payments.status)
                 then excluded.status
               else public.payments.status
             end,
    raw_payload = case
                    when app.status_rank(excluded.status) >= app.status_rank(public.payments.status)
                      then excluded.raw_payload
                    else public.payments.raw_payload
                  end,
    event             = coalesce(excluded.event, public.payments.event),
    kashier_order_id  = coalesce(excluded.kashier_order_id, public.payments.kashier_order_id),
    merchant_order_id = coalesce(excluded.merchant_order_id, public.payments.merchant_order_id),
    order_reference   = coalesce(excluded.order_reference, public.payments.order_reference),
    amount            = coalesce(excluded.amount, public.payments.amount),
    currency          = coalesce(excluded.currency, public.payments.currency),
    settled_amount    = coalesce(excluded.settled_amount, public.payments.settled_amount),
    fees              = coalesce(excluded.fees, public.payments.fees),
    vat               = coalesce(excluded.vat, public.payments.vat),
    method            = coalesce(excluded.method, public.payments.method),
    channel           = coalesce(excluded.channel, public.payments.channel),
    card_brand        = coalesce(excluded.card_brand, public.payments.card_brand),
    masked_card       = coalesce(excluded.masked_card, public.payments.masked_card),
    card_holder_name  = coalesce(excluded.card_holder_name, public.payments.card_holder_name),
    apikey_name       = coalesce(excluded.apikey_name, public.payments.apikey_name),
    transaction_date  = coalesce(excluded.transaction_date, public.payments.transaction_date),
    response_code     = coalesce(excluded.response_code, public.payments.response_code),
    response_message  = coalesce(excluded.response_message, public.payments.response_message),
    is_test_webhook   = public.payments.is_test_webhook or excluded.is_test_webhook,
    -- coalesce keeps a value a later, thinner delivery would otherwise erase.
    ukkera_transfer_id = coalesce(excluded.ukkera_transfer_id, public.payments.ukkera_transfer_id),
    payer_name         = coalesce(excluded.payer_name, public.payments.payer_name),
    payer_email        = coalesce(excluded.payer_email, public.payments.payer_email),
    payer_phone        = coalesce(excluded.payer_phone, public.payments.payer_phone),
    updated_at        = now()
  returning id into v_id;

  -- 0015 added these two calls in the database without updating 0004's copy of
  -- the body. Redefining the function from that stale copy silently dropped
  -- the ledger sync — every future payment would have landed with no entry.
  -- They are part of the definition now, so the file cannot lose them again.
  perform app.derive_order_from_payment(v_id);
  perform app.sync_payment_to_ledger(v_id);
end;
$$;

-- ---------------------------------------------------------------------------
-- Match on the identifier that is actually shared
-- ---------------------------------------------------------------------------

create or replace view public.v_payment_matches
with (security_invoker = on) as
select
  p.id                                        as payment_id,
  coalesce(o.subscription_id, su.id, sm.id)   as subscription_id,
  case
    when o.subscription_id is not null then 'override'
    when su.id is not null              then 'auto_ukkera_transfer'
    when sm.id is not null              then 'auto_order_key'
    else 'none'
  end                                         as match_method
from public.payments p
left join public.payment_subscription_overrides o
       on o.payment_id = p.id
-- Preferred: ukkera's own transfer_id, which both sides genuinely share.
left join public.subscriptions su
       on su.order_key = p.ukkera_transfer_key
      and o.subscription_id is null
-- Fallback: the original merchantOrderId guess. Retained because a different
-- ukkera product may yet put a real order id there.
left join public.subscriptions sm
       on sm.order_key = p.merchant_order_key
      and o.subscription_id is null
      and su.id is null;

create or replace view public.v_payment_match_health
with (security_invoker = on) as
select
  m.mode,
  count(*)                                                     as payments,
  count(*) filter (where m.match_method like 'auto%')           as auto_matched,
  count(*) filter (where m.match_method = 'override')           as manually_linked,
  count(*) filter (where m.match_method = 'none')               as unmatched,
  case
    when count(*) = 0 then null
    else round(100.0 * count(*) filter (where m.match_method like 'auto%') / count(*), 1)
  end                                                          as auto_match_rate,
  min(m.transaction_date) filter (where m.match_method = 'none') as oldest_unmatched_at,
  max(m.transaction_date)                                      as latest_payment_at
from (
  select p.mode, p.transaction_date, v.match_method
  from public.payments p
  join public.v_payment_matches v on v.payment_id = p.id
  where p.event in ('pay', 'capture')
    and not (p.mode = 'test' or p.is_test_webhook)
) m
group by m.mode;

-- ---------------------------------------------------------------------------
-- Backfill what has already arrived
-- ---------------------------------------------------------------------------

update public.payments p
set ukkera_transfer_id = coalesce(
      p.ukkera_transfer_id,
      nullif(btrim(coalesce(app.ukkera_meta(p.raw_payload) ->> 'transfer_id', '')), '')),
    payer_name = coalesce(
      p.payer_name,
      nullif(btrim(coalesce(app.ukkera_meta(p.raw_payload) -> 'account' ->> 'name', '')), '')),
    payer_email = coalesce(
      p.payer_email,
      nullif(btrim(coalesce(app.ukkera_meta(p.raw_payload) -> 'account' ->> 'email', '')), '')),
    payer_phone = coalesce(
      p.payer_phone,
      nullif(btrim(coalesce(app.ukkera_meta(p.raw_payload) -> 'account' ->> 'phone', '')), ''))
where app.ukkera_meta(p.raw_payload) <> '{}'::jsonb;

-- ---------------------------------------------------------------------------
-- Attribution, on the key that actually matches
-- ---------------------------------------------------------------------------
-- Both of these looked up the subscription by merchant_order_key alone, which
-- was the assumption that just failed. Ordered rather than OR-ed so the weaker
-- key can never win a tie.

create or replace function app.attach_subscription_to_ledger()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  update public.ledger_entries e
     set subscription_id = new.id,
         student_id      = coalesce(e.student_id, new.student_id),
         course_id       = coalesce(e.course_id, new.course_id),
         updated_at      = now()
    from public.payments p
   where e.payment_id = p.id
     and e.voided_at is null
     and e.subscription_id is null
     and (p.ukkera_transfer_key = new.order_key
          or p.merchant_order_key = new.order_key);
  return new;
end;
$$;

-- app.sync_payment_to_ledger keeps its 0017 body; only the subscription lookup
-- and two metadata fields change. See migration
-- `sync_payment_to_ledger_prefers_ukkera_transfer_key` for the applied form:
--
--   where s.order_key in (p.ukkera_transfer_key, p.merchant_order_key)
--   order by (s.order_key is distinct from p.ukkera_transfer_key)
--
-- ---------------------------------------------------------------------------
-- The payer, on the view the dashboard reads
-- ---------------------------------------------------------------------------
-- Appended at the end so existing column order is untouched. An unattributed
-- payment can now say whose money it is instead of showing a dash.
--
-- See migration `payments_enriched_carries_the_payer` for the full body; the
-- only change is four columns added after package_name:
--   p.ukkera_transfer_id, p.payer_name, p.payer_phone, p.payer_email
