-- 0004_projections.sql
-- Ingest entry points and the projections that turn raw deliveries into
-- domain rows.
--
-- Contract with the Edge Functions: `app.ingest_*` NEVER raises. Kashier
-- treats any non-2xx as a failure and retries for ~23.5 hours, so a bug in a
-- projection must not turn into a retry storm. Projection errors are captured
-- on the raw row and swept later.

-- ===========================================================================
-- Kashier: transaction projection
-- ===========================================================================

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
    is_test_webhook, raw_payload
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
    p_raw.payload
  )
  on conflict (transaction_id, mode) do update set
    -- Deliveries are unordered. Only ever move a status forward.
    status = case
               when app.status_rank(excluded.status) >= app.status_rank(public.payments.status)
                 then excluded.status
               else public.payments.status
             end,
    -- Same guard for every field that describes the current state: a stale
    -- delivery must not overwrite fresher data.
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
    updated_at        = now();
end;
$$;

-- ===========================================================================
-- Kashier: transfer (payout) projection
-- ===========================================================================
-- The transfer payload shape is not published yet. Field names are probed
-- defensively and the whole body is always retained, so once the real shape is
-- confirmed this function can be widened and the sweeper will reprocess every
-- row that failed here.

create or replace function app.project_kashier_transfer(p_raw public.kashier_events_raw)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  d        jsonb := coalesce(p_raw.payload -> 'data', p_raw.payload, '{}'::jsonb);
  v_id     text;
  v_event  public.kashier_transfer_event;
begin
  v_id := nullif(btrim(coalesce(
            d ->> 'transferId', d ->> 'transfer_id', d ->> 'transferID',
            d ->> 'payoutId',   d ->> 'id',          d ->> 'reference', '')), '');

  if v_id is null then
    -- Deliberately retryable, not ignored: this is very likely our extractor
    -- being wrong about the field name rather than a bad payload.
    raise exception 'transfer payload has no recognisable transfer id; keys=%',
      (select string_agg(k, ',' order by k) from jsonb_object_keys(d) k);
  end if;

  begin
    v_event := upper(btrim(p_raw.event))::public.kashier_transfer_event;
  exception when others then
    raise exception 'IGNORE: unsupported transfer event %', coalesce(p_raw.event, '<null>');
  end;

  insert into public.payouts (
    transfer_id, event, mode, amount, currency, reference, transfer_date, raw_payload
  ) values (
    v_id,
    v_event,
    p_raw.mode,
    app.to_numeric(coalesce(d ->> 'amount', d ->> 'transferAmount', d ->> 'netAmount')),
    coalesce(d ->> 'currency', 'EGP'),
    coalesce(d ->> 'reference', d ->> 'merchantReference'),
    app.to_timestamptz(coalesce(d ->> 'transferDate', d ->> 'creationDate', d ->> 'date')),
    p_raw.payload
  )
  on conflict (transfer_id, mode) do update set
    event         = excluded.event,
    amount        = coalesce(excluded.amount, public.payouts.amount),
    currency      = coalesce(excluded.currency, public.payouts.currency),
    reference     = coalesce(excluded.reference, public.payouts.reference),
    transfer_date = coalesce(excluded.transfer_date, public.payouts.transfer_date),
    raw_payload   = excluded.raw_payload,
    updated_at    = now();
end;
$$;

-- ===========================================================================
-- Kashier: dispatcher + ingest entry point
-- ===========================================================================

create or replace function app.process_kashier_raw(p_id uuid)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  r public.kashier_events_raw;
begin
  select * into r from public.kashier_events_raw where id = p_id for update;
  if not found then return 'missing'; end if;
  if r.state = 'processed' then return 'processed'; end if;

  begin
    if r.resource_type = 'transfer' then
      perform app.project_kashier_transfer(r);
    else
      perform app.project_kashier_transaction(r);
    end if;

    update public.kashier_events_raw
       set state = 'processed', processed_at = now(), process_error = null,
           process_attempts = process_attempts + 1
     where id = p_id;
    return 'processed';

  exception when others then
    -- 'IGNORE:' marks a permanent condition that retrying cannot fix.
    update public.kashier_events_raw
       set state = (case when sqlerrm like 'IGNORE:%' then 'ignored' else 'failed' end)::app.ingest_state,
           process_error = sqlerrm,
           process_attempts = process_attempts + 1
     where id = p_id;
    return case when sqlerrm like 'IGNORE:%' then 'ignored' else 'failed' end;
  end;
end;
$$;

create or replace function app.ingest_kashier_event(
  p_payload        jsonb,
  p_body_sha256    text,
  p_signature_valid boolean,
  p_mode           public.kashier_mode,
  p_resource_type  text default 'transaction',
  p_source         text default 'configured',
  p_signature_note text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id     uuid;
  v_event  text := p_payload ->> 'event';
  v_result text;
begin
  insert into public.kashier_events_raw (
    event, resource_type, mode, source, payload, body_sha256,
    signature_valid, signature_note
  ) values (
    v_event, p_resource_type, p_mode, p_source, p_payload, p_body_sha256,
    p_signature_valid, p_signature_note
  )
  on conflict (body_sha256) do nothing
  returning id into v_id;

  if v_id is null then
    -- Byte-identical body already seen: a Kashier retry or a manual resend.
    update public.kashier_events_raw
       set duplicate_count = duplicate_count + 1, last_duplicate_at = now()
     where body_sha256 = p_body_sha256
     returning id into v_id;
    return jsonb_build_object('status', 'duplicate', 'raw_id', v_id);
  end if;

  v_result := app.process_kashier_raw(v_id);
  return jsonb_build_object('status', 'accepted', 'raw_id', v_id, 'processing', v_result);
end;
$$;

-- ===========================================================================
-- ukkera: projection + ingest entry point
-- ===========================================================================

create or replace function app.project_ukkera_event(p_raw public.ukkera_events_raw)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  p           jsonb := p_raw.payload;
  v_order_id  text  := nullif(btrim(coalesce(p ->> 'order_id', '')), '');
  v_name      text  := nullif(btrim(coalesce(p ->> 'student_name', '')), '');
  v_phone     text  := p ->> 'phone';
  v_phone_n   text  := app.normalize_phone(v_phone);
  v_course    text  := nullif(btrim(coalesce(p ->> 'course', '')), '');
  v_amount    numeric := app.to_numeric(p ->> 'amount');
  v_date      date;
  v_student   uuid;
  v_course_id uuid;
  v_match_count int;
begin
  if v_order_id is null then
    raise exception 'IGNORE: ukkera payload has no order_id';
  end if;

  begin
    v_date := (p ->> 'payment_date')::date;
  exception when others then
    v_date := null;
  end;

  -- Course: upsert by normalised name.
  if v_course is not null then
    insert into public.courses (name) values (v_course)
    on conflict (name_key) do update set updated_at = now()
    returning id into v_course_id;
  end if;

  -- Student resolution.
  -- 1. Phone is the only identifier ukkera gives us that is stable across
  --    spellings of a name, so it is tried first.
  if v_phone_n is not null then
    select id into v_student
      from public.students
     where phone_normalized = v_phone_n
     order by (upper(btrim(name)) = upper(btrim(coalesce(v_name, '')))) desc, created_at asc
     limit 1;
  end if;

  -- 2. No phone: fall back to an exact name match, but only when it is
  --    unambiguous. Guessing between two same-named students would silently
  --    attach money to the wrong person.
  if v_student is null and v_name is not null then
    -- min(uuid) has no aggregate in Postgres; count first, then fetch the row.
    select count(*) into v_match_count
      from public.students
     where upper(btrim(name)) = upper(btrim(v_name));
    if v_match_count = 1 then
      select id into v_student
        from public.students
       where upper(btrim(name)) = upper(btrim(v_name))
       limit 1;
    end if;
  end if;

  if v_student is null and v_name is not null then
    insert into public.students (name, phone) values (v_name, v_phone)
    returning id into v_student;
  elsif v_student is not null then
    -- Backfill only; never overwrite data we already hold.
    update public.students
       set phone = coalesce(phone, v_phone),
           name  = case when btrim(coalesce(name, '')) = '' then coalesce(v_name, name) else name end
     where id = v_student;
  end if;

  insert into public.subscriptions (
    student_id, course_id, order_id, amount, payment_date, source
  ) values (
    v_student, v_course_id, v_order_id, v_amount, v_date, 'ukkera_webhook'
  )
  on conflict (order_key) do update set
    student_id   = coalesce(public.subscriptions.student_id, excluded.student_id),
    course_id    = coalesce(excluded.course_id, public.subscriptions.course_id),
    amount       = coalesce(excluded.amount, public.subscriptions.amount),
    payment_date = coalesce(excluded.payment_date, public.subscriptions.payment_date),
    updated_at   = now();
end;
$$;

create or replace function app.process_ukkera_raw(p_id uuid)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  r public.ukkera_events_raw;
begin
  select * into r from public.ukkera_events_raw where id = p_id for update;
  if not found then return 'missing'; end if;
  if r.state = 'processed' then return 'processed'; end if;

  begin
    perform app.project_ukkera_event(r);
    update public.ukkera_events_raw
       set state = 'processed', processed_at = now(), process_error = null,
           process_attempts = process_attempts + 1
     where id = p_id;
    return 'processed';
  exception when others then
    update public.ukkera_events_raw
       set state = (case when sqlerrm like 'IGNORE:%' then 'ignored' else 'failed' end)::app.ingest_state,
           process_error = sqlerrm,
           process_attempts = process_attempts + 1
     where id = p_id;
    return case when sqlerrm like 'IGNORE:%' then 'ignored' else 'failed' end;
  end;
end;
$$;

create or replace function app.ingest_ukkera_event(
  p_payload     jsonb,
  p_body_sha256 text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
  v_result text;
begin
  insert into public.ukkera_events_raw (payload, body_sha256)
  values (p_payload, p_body_sha256)
  on conflict (body_sha256) do nothing
  returning id into v_id;

  if v_id is null then
    update public.ukkera_events_raw
       set duplicate_count = duplicate_count + 1, last_duplicate_at = now()
     where body_sha256 = p_body_sha256
     returning id into v_id;
    return jsonb_build_object('status', 'duplicate', 'raw_id', v_id);
  end if;

  v_result := app.process_ukkera_raw(v_id);
  return jsonb_build_object('status', 'accepted', 'raw_id', v_id, 'processing', v_result);
end;
$$;

-- ===========================================================================
-- Sweepers — retry anything the inline projection could not finish
-- ===========================================================================

create or replace function app.sweep_failed_events(p_limit int default 200, p_max_attempts int default 12)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  r record;
  n_kashier int := 0;
  n_ukkera  int := 0;
begin
  for r in
    select id from public.kashier_events_raw
     where state in ('pending','failed') and process_attempts < p_max_attempts
     order by received_at asc limit p_limit
  loop
    perform app.process_kashier_raw(r.id);
    n_kashier := n_kashier + 1;
  end loop;

  for r in
    select id from public.ukkera_events_raw
     where state in ('pending','failed') and process_attempts < p_max_attempts
     order by received_at asc limit p_limit
  loop
    perform app.process_ukkera_raw(r.id);
    n_ukkera := n_ukkera + 1;
  end loop;

  return jsonb_build_object('kashier', n_kashier, 'ukkera', n_ukkera);
end;
$$;
