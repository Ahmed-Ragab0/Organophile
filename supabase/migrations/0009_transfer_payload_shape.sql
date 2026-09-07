-- 0009_transfer_payload_shape.sql
--
-- The real transfer payload was captured from a Kashier "Test Webhook" fire
-- that we refused for having no signature. Because the endpoint stores a body
-- excerpt for every rejected delivery, the undocumented shape was recoverable
-- without ever having trusted the request:
--
--   { "isTestWebhook": true, "transferId": "TEST-TRS-0001", "amount": 100,
--     "method": "wallet", "recipientName": "...", "recipientNumber": "0100...",
--     "merchantTransferId": "TEST-TRANSFER-0001", "status": "TRANSFERRED",
--     "openForReturn": false, "transferResponseCode": "00",
--     "transferResponseMessage": { "en": "...", "ar": "..." },
--     "merchantId": "MID-...", "date": "2026-09-07T12:12:05.602Z",
--     "signatureKeys": ["merchantTransferId","method","amount","merchantId","status"] }
--
-- Two things this confirms:
--   * the object is FLAT — there is no `data` wrapper like transaction events;
--   * the event value lives in `status`, not in an `event` field.

alter table public.payouts
  add column if not exists method               text,
  add column if not exists recipient_name       text,
  add column if not exists recipient_number     text,
  add column if not exists merchant_transfer_id text,
  add column if not exists response_code        text,
  add column if not exists response_message     text;

create index if not exists payouts_merchant_transfer_idx
  on public.payouts (merchant_transfer_id)
  where merchant_transfer_id is not null;

create or replace function app.project_kashier_transfer(p_raw public.kashier_events_raw)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  -- Transfer payloads are flat, but keep the `data` fallback in case a
  -- configured (non-test) delivery wraps them the way transactions are wrapped.
  d        jsonb := coalesce(p_raw.payload -> 'data', p_raw.payload, '{}'::jsonb);
  v_id     text;
  v_event  public.kashier_transfer_event;
  v_raw_ev text;
begin
  v_id := nullif(btrim(coalesce(
            d ->> 'transferId', d ->> 'transfer_id', d ->> 'transferID',
            d ->> 'payoutId',   d ->> 'id',          d ->> 'reference', '')), '');

  if v_id is null then
    raise exception 'transfer payload has no recognisable transfer id; keys=%',
      (select string_agg(k, ',' order by k) from jsonb_object_keys(d) k);
  end if;

  -- The event value can arrive either as the webhook's `event` (a configured
  -- transfer webhook) or as `status` inside the object (the combined test
  -- envelope, which carries no top-level event at all).
  v_raw_ev := coalesce(nullif(btrim(coalesce(p_raw.event, '')), ''), d ->> 'status');

  begin
    v_event := upper(btrim(v_raw_ev))::public.kashier_transfer_event;
  exception when others then
    raise exception 'IGNORE: unsupported transfer event %', coalesce(v_raw_ev, '<null>');
  end;

  insert into public.payouts (
    transfer_id, event, mode, amount, currency, reference, transfer_date,
    method, recipient_name, recipient_number, merchant_transfer_id,
    response_code, response_message, raw_payload
  ) values (
    v_id,
    v_event,
    p_raw.mode,
    app.to_numeric(coalesce(d ->> 'amount', d ->> 'transferAmount', d ->> 'netAmount')),
    coalesce(d ->> 'currency', 'EGP'),
    coalesce(d ->> 'reference', d ->> 'merchantReference', d ->> 'merchantTransferId'),
    app.to_timestamptz(coalesce(d ->> 'date', d ->> 'transferDate', d ->> 'creationDate')),
    d ->> 'method',
    d ->> 'recipientName',
    d ->> 'recipientNumber',
    d ->> 'merchantTransferId',
    d ->> 'transferResponseCode',
    coalesce(d -> 'transferResponseMessage' ->> 'en', d ->> 'transferResponseMessage'),
    p_raw.payload
  )
  on conflict (transfer_id, mode) do update set
    event                = excluded.event,
    amount               = coalesce(excluded.amount, public.payouts.amount),
    currency             = coalesce(excluded.currency, public.payouts.currency),
    reference            = coalesce(excluded.reference, public.payouts.reference),
    transfer_date        = coalesce(excluded.transfer_date, public.payouts.transfer_date),
    method               = coalesce(excluded.method, public.payouts.method),
    recipient_name       = coalesce(excluded.recipient_name, public.payouts.recipient_name),
    recipient_number     = coalesce(excluded.recipient_number, public.payouts.recipient_number),
    merchant_transfer_id = coalesce(excluded.merchant_transfer_id, public.payouts.merchant_transfer_id),
    response_code        = coalesce(excluded.response_code, public.payouts.response_code),
    response_message     = coalesce(excluded.response_message, public.payouts.response_message),
    raw_payload          = excluded.raw_payload,
    updated_at           = now();
end;
$$;
