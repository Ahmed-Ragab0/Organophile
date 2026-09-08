-- ukkera and Kashier describe the same purchase and share no identifier.
--
-- ukkera calls it transfer 847. Kashier calls it
-- transfer-+201010731171-1788881393490. Kashier's payload also carries a field
-- literally named `transfer_id` — but that one is 459 for every buyer, because
-- it identifies the payment LINK. Two systems, three ids, one purchase, and the
-- one field whose name promised a match was the wrong one.
--
-- Because each side had its own key and neither recognised the other's, each
-- wrote its own subscription row: two students, four subscriptions, and an
-- "outstanding" balance for orders that were already paid.
--
-- A subscription therefore carries BOTH identities, and whichever side arrives
-- second adopts the row the first one made rather than creating another. The
-- bridge is the buyer, the amount and the moment, which is the most either
-- system gives us — so it is deliberately narrow: same student, same amount to
-- the piastre, within hours, and only ever onto a row still missing that side.

alter table public.subscriptions
  add column if not exists merchant_order_key  text,
  add column if not exists ukkera_transfer_id  text,
  add column if not exists ukkera_transfer_at  timestamptz;

comment on column public.subscriptions.merchant_order_key is
  'Kashier''s merchantOrderId, uppercased. Unique per purchase — the money side.';
comment on column public.subscriptions.ukkera_transfer_id is
  'ukkera''s own transfer id from its webhook. Unique per purchase — the roster '
  'side. NOT the transfer_id inside Kashier metaData, which is the link id.';

create unique index if not exists subscriptions_merchant_order_key_uniq
  on public.subscriptions (merchant_order_key) where merchant_order_key is not null;
create unique index if not exists subscriptions_ukkera_transfer_uniq
  on public.subscriptions (ukkera_transfer_id) where ukkera_transfer_id is not null;

-- ---------------------------------------------------------------------------
-- the bridge
--
-- Anchored on the payment's own transaction date rather than on when we
-- ingested the row: for a backfill those are hours apart, and the purchase
-- moment is the only thing the two systems actually agree on. They agree to
-- the second in practice (12:35:32 / 12:35:32.119).
--
-- Four hours: wide enough to survive an ukkera payload that ever arrives in
-- Cairo local time without an offset (a three-hour slip), narrow enough that
-- the same student paying the same amount twice in one day still resolves to
-- the nearer of the two.
-- ---------------------------------------------------------------------------
create or replace function app.find_sibling_subscription(
  p_student uuid,
  p_amount  numeric,
  p_at      timestamptz,
  p_missing text          -- 'kashier' | 'ukkera': which side the row must lack
) returns uuid
language sql stable security definer set search_path = '' as $$
  with candidate as (
    select s.id,
           coalesce(
             s.ukkera_transfer_at,
             (select max(p.transaction_date) from public.payments p
               where p.merchant_order_key = s.merchant_order_key),
             s.created_at) as at
      from public.subscriptions s
     where p_student is not null and s.student_id = p_student
       and (case p_missing
              when 'kashier' then s.merchant_order_key is null
              when 'ukkera'  then s.ukkera_transfer_id is null
            end)
       -- Same money. An instalment and a full payment are different purchases
       -- even for the same student on the same day.
       and p_amount is not null and s.amount is not null
       and abs(s.amount - p_amount) < 0.01
  )
  select id from candidate
   where p_at is not null
     and abs(extract(epoch from (at - p_at))) < 14400
   order by abs(extract(epoch from (at - p_at)))
   limit 1
$$;

comment on function app.find_sibling_subscription is
  'Finds the row the other system already wrote for this same purchase, so the '
  'second arrival adopts it instead of duplicating it.';

-- ---------------------------------------------------------------------------
-- Kashier side
-- ---------------------------------------------------------------------------
create or replace function app.derive_order_from_payment(p_payment_id uuid)
returns uuid language plpgsql security definer set search_path = '' as $function$
declare
  p         public.payments;
  v_student uuid;
  v_sub     uuid;
begin
  select * into p from public.payments where id = p_payment_id;
  if not found then return null; end if;

  if p.status <> 'SUCCESS' then return null; end if;
  if p.event not in ('pay', 'capture') then return null; end if;
  -- merchantOrderId, not transfer_id: the latter identifies the payment link
  -- and is shared by every buyer through it.
  if p.merchant_order_id is null then return null; end if;

  select id into v_sub
    from public.subscriptions
   where merchant_order_key = p.merchant_order_key;
  if found then return v_sub; end if;

  if p.payer_phone_normalized is not null then
    select id into v_student
      from public.students
     where phone_normalized = p.payer_phone_normalized
     order by created_at
     limit 1;
  end if;

  if v_student is null and btrim(coalesce(p.payer_name, '')) <> '' then
    insert into public.students (name, phone, email)
    values (btrim(p.payer_name), p.payer_phone, p.payer_email)
    returning id into v_student;
  end if;

  -- ukkera may already have recorded this purchase, with the course and package
  -- we cannot see from here. Adopt that row rather than starting a rival one.
  v_sub := app.find_sibling_subscription(
             v_student, p.amount,
             coalesce(p.transaction_date, p.created_at), 'kashier');

  if v_sub is not null then
    update public.subscriptions
       set merchant_order_key = p.merchant_order_key,
           payment_date  = coalesce(payment_date,
                             (p.transaction_date at time zone 'Africa/Cairo')::date),
           student_id    = coalesce(student_id, v_student),
           updated_at    = now()
     where id = v_sub;
    return v_sub;
  end if;

  insert into public.subscriptions (
    student_id, order_id, merchant_order_key, amount, payment_date, source, notes
  ) values (
    v_student,
    p.merchant_order_id,
    p.merchant_order_key,
    p.amount,
    (p.transaction_date at time zone 'Africa/Cairo')::date,
    'kashier_metadata',
    'ukkera link ' || coalesce(p.ukkera_transfer_id, '?')
  )
  on conflict (order_key) do update set
    student_id         = coalesce(public.subscriptions.student_id, excluded.student_id),
    merchant_order_key = coalesce(public.subscriptions.merchant_order_key,
                                  excluded.merchant_order_key),
    updated_at = now()
  returning id into v_sub;

  return v_sub;
end;
$function$;

-- ---------------------------------------------------------------------------
-- everything that reads a payment's subscription now reads the money-side key
-- ---------------------------------------------------------------------------
create or replace view public.v_payment_matches as
select p.id as payment_id,
       coalesce(o.subscription_id, sm.id) as subscription_id,
       case when o.subscription_id is not null then 'override'
            when sm.id is not null then 'auto_order_key'
            else 'none' end as match_method
  from public.payments p
  left join public.payment_subscription_overrides o on o.payment_id = p.id
  left join public.subscriptions sm
         on sm.merchant_order_key = p.merchant_order_key and o.subscription_id is null;
alter view public.v_payment_matches set (security_invoker = on);

create or replace view public.v_unpaid_subscriptions as
select s.id, s.order_id, s.amount, s.payment_date, s.created_at,
       st.name as student_name, st.phone as student_phone, c.name as course_name
  from public.subscriptions s
  left join public.students st on st.id = s.student_id
  left join public.courses c on c.id = s.course_id
 where not exists (
         select 1 from public.payments p
          where p.merchant_order_key = s.merchant_order_key
            and p.status = 'SUCCESS' and p.event in ('pay', 'capture'))
   and not exists (
         select 1 from public.payment_subscription_overrides o
           join public.payments p2 on p2.id = o.payment_id
          where o.subscription_id = s.id
            and p2.status = 'SUCCESS' and p2.event in ('pay', 'capture'));
alter view public.v_unpaid_subscriptions set (security_invoker = on);

create or replace function app.attach_subscription_to_ledger()
returns trigger language plpgsql security definer set search_path = '' as $function$
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
     and new.merchant_order_key is not null
     and p.merchant_order_key = new.merchant_order_key;
  return new;
end;
$function$;

-- The trigger listened for order_id, student_id and course_id. Linking a
-- payment to a subscription now happens by setting merchant_order_key, so
-- without it here the adoption path would attach nothing and leave the ledger
-- entry orphaned — silently, which is the worst way to be wrong about money.
drop trigger if exists subscriptions_attach_ledger on public.subscriptions;
create trigger subscriptions_attach_ledger
  after insert or update of order_id, student_id, course_id, merchant_order_key
  on public.subscriptions
  for each row execute function app.attach_subscription_to_ledger();

-- sync_payment_to_ledger resolved the subscription through order_key, which is
-- the ukkera-or-Kashier display id. It has to use the money-side key like every
-- other payment lookup, or a purchase ukkera registered first would post its
-- revenue against no subscription at all. This is also where the fee entry
-- switches from 'expense' to 'gateway_fee' (see 0027).
--
-- Patched from pg_get_functiondef, never from an older migration's copy: this
-- body has been edited in place since it was first written.
create or replace function app.sync_payment_to_ledger(p_payment_id uuid)
returns void language plpgsql security definer set search_path = '' as $function$
declare
  p public.payments; v_type public.ledger_entry_type; v_wallet uuid;
  v_sub record; v_fees numeric; v_test boolean;
  v_gateway numeric; v_vat numeric; v_bank numeric;
begin
  select * into p from public.payments where id = p_payment_id;
  if not found then return; end if;
  if p.status <> 'SUCCESS' then return; end if;

  v_type := case p.event
              when 'pay' then 'revenue' when 'capture' then 'revenue'
              when 'refund' then 'refund' when 'reversal' then 'reversal'
              else null end;
  if v_type is null then return; end if;

  select id into v_wallet from public.wallets where is_kashier_default and is_active;
  if v_wallet is null then
    raise exception 'no active wallet is marked is_kashier_default';
  end if;

  select s.id as subscription_id, s.student_id, s.course_id
    into v_sub
    from public.subscriptions s
   where s.merchant_order_key = p.merchant_order_key
   limit 1;

  v_test    := (p.mode = 'test' or p.is_test_webhook);
  v_gateway := coalesce(p.fees, 0);
  v_vat     := coalesce(p.vat, 0);
  v_bank    := app.bank_fee_at(p.mode, p.transaction_date);
  v_fees    := v_gateway + v_vat + v_bank;

  insert into public.ledger_entries (
    entry_type, wallet_id, amount, occurred_at, description,
    student_id, course_id, subscription_id, payment_id, reference, metadata, is_test
  ) values (
    v_type, v_wallet, abs(coalesce(p.amount, 0)),
    coalesce(p.transaction_date, p.created_at),
    case v_type when 'revenue' then 'دفعة كاشير'
                when 'refund' then 'استرداد كاشير'
                when 'reversal' then 'عكس عملية كاشير' end,
    v_sub.student_id, v_sub.course_id, v_sub.subscription_id, p.id, p.transaction_id,
    -- The three numbers travel with the entry so a single row answers "what
    -- did they pay, what was taken, what did I get" without a join.
    jsonb_build_object('source', 'kashier',
      'kashier_order_id', p.kashier_order_id, 'merchant_order_id', p.merchant_order_id,
      'ukkera_link_id', p.ukkera_transfer_id, 'payer_name', p.payer_name,
      'method', p.method, 'apikey_name', p.apikey_name,
      'settled_amount', p.settled_amount,
      'gross', abs(coalesce(p.amount, 0)), 'fees_total', v_fees,
      'net', abs(coalesce(p.amount, 0)) - v_fees),
    v_test
  )
  on conflict (payment_id, entry_type) where payment_id is not null and voided_at is null
  do update set
    amount = excluded.amount, occurred_at = excluded.occurred_at,
    wallet_id = excluded.wallet_id,
    -- Overwrite rather than coalesce: a wrong attribution has to be
    -- correctable by re-running this, and coalesce would preserve it forever.
    student_id = excluded.student_id, course_id = excluded.course_id,
    subscription_id = excluded.subscription_id,
    metadata = excluded.metadata, is_test = excluded.is_test, updated_at = now();

  if v_type = 'revenue' and v_fees > 0 then
    insert into public.ledger_entries (
      entry_type, wallet_id, amount, occurred_at, description,
      student_id, course_id, subscription_id, payment_id, reference, category, metadata, is_test
    ) values (
      'gateway_fee', v_wallet, v_fees, coalesce(p.transaction_date, p.created_at),
      'رسوم كاشير', v_sub.student_id, v_sub.course_id, v_sub.subscription_id,
      p.id, p.transaction_id, 'رسوم كاشير',
      jsonb_build_object('source', 'kashier_fees',
        'gateway_fee', v_gateway, 'vat', v_vat, 'bank_fee', v_bank,
        'gross', abs(coalesce(p.amount, 0)),
        'net', abs(coalesce(p.amount, 0)) - v_fees),
      v_test
    )
    on conflict (payment_id, entry_type) where payment_id is not null and voided_at is null
    do update set
      amount = excluded.amount, occurred_at = excluded.occurred_at,
      wallet_id = excluded.wallet_id,
      student_id = excluded.student_id, course_id = excluded.course_id,
      subscription_id = excluded.subscription_id,
      metadata = excluded.metadata, is_test = excluded.is_test, updated_at = now();
  end if;
end;
$function$;

-- The repair of the rows the split keys already produced lives at the end of
-- 0031: it replays the ukkera deliveries, and that replay must run against the
-- projection that knows about both identities — which 0031 is what defines.
