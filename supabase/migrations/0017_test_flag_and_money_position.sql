-- 0017 — stop a Kashier test delivery counting as real money, and make the
-- money's position answerable in one query.
--
-- Part 1 is a correctness fix. Parts 2-4 are the views the dashboard needs to
-- answer "someone bought a course — did they pay, did Kashier get it, and has
-- it reached my bank?" without three separate investigations.

-- ── 1. `is_test` was derived from the endpoint, not from the payload ────────
--
-- `sync_payment_to_ledger` set `is_test := (p.mode = 'test')`. But Kashier's
-- dashboard has a **Test** button that posts a synthetic payload to whichever
-- URL you point it at, including the live one, and marks it `isTestWebhook`.
-- Press it against `?mode=live` and the projection booked a fake payment as
-- real revenue: it moved the wallet balance, entered the P&L, and broke the
-- invariant that `sum(wallet balances) = opening + revenue − expenses` against
-- reality.
--
-- That already happened once on this project — TEST-TRX-0001 for 100 EGP is
-- sitting in the live books — which is what this migration also cleans up.
--
-- The rule is now: an entry is test if EITHER signal says so. `is_test_webhook`
-- is already OR-ed across redeliveries by the payments upsert, so a delivery
-- that was ever flagged test stays test.

create or replace function app.sync_payment_to_ledger(p_payment_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $function$
declare
  p        public.payments;
  v_type   public.ledger_entry_type;
  v_wallet uuid;
  v_sub    record;
begin
  select * into p from public.payments where id = p_payment_id;
  if not found then return; end if;
  if p.status <> 'SUCCESS' then return; end if;

  v_type := case p.event
              when 'pay'      then 'revenue'
              when 'capture'  then 'revenue'
              when 'refund'   then 'refund'
              when 'reversal' then 'reversal'
              else null
            end;
  if v_type is null then return; end if;

  select id into v_wallet from public.wallets where is_kashier_default and is_active;
  if v_wallet is null then
    raise exception 'no active wallet is marked is_kashier_default';
  end if;

  select s.id as subscription_id, s.student_id, s.course_id
    into v_sub
    from public.subscriptions s
   where s.order_key = p.merchant_order_key
   limit 1;

  insert into public.ledger_entries (
    entry_type, wallet_id, amount, occurred_at, description,
    student_id, course_id, subscription_id, payment_id,
    reference, metadata, is_test
  ) values (
    v_type, v_wallet, abs(coalesce(p.amount, 0)),
    coalesce(p.transaction_date, p.created_at),
    case v_type
      when 'revenue'  then 'دفعة كاشير'
      when 'refund'   then 'استرداد كاشير'
      when 'reversal' then 'عكس عملية كاشير'
    end,
    v_sub.student_id, v_sub.course_id, v_sub.subscription_id, p.id,
    p.transaction_id,
    jsonb_build_object(
      'source', 'kashier',
      'kashier_order_id', p.kashier_order_id,
      'merchant_order_id', p.merchant_order_id,
      'method', p.method,
      'apikey_name', p.apikey_name,
      'settled_amount', p.settled_amount,
      'fees', p.fees),
    -- The fix. Either signal is enough to keep it out of the books.
    (p.mode = 'test' or p.is_test_webhook)
  )
  on conflict (payment_id) where payment_id is not null and voided_at is null
  do update set
    amount          = excluded.amount,
    occurred_at     = excluded.occurred_at,
    entry_type      = excluded.entry_type,
    student_id      = coalesce(public.ledger_entries.student_id, excluded.student_id),
    course_id       = coalesce(public.ledger_entries.course_id, excluded.course_id),
    subscription_id = coalesce(public.ledger_entries.subscription_id, excluded.subscription_id),
    metadata        = excluded.metadata,
    -- A redelivery that reveals the payment was a test must be able to pull the
    -- entry back OUT of the books, so this is not `coalesce`-guarded.
    is_test         = excluded.is_test,
    updated_at      = now();
end;
$function$;

-- Backfill: any entry whose payment was flagged as a Kashier test delivery.
update public.ledger_entries e
   set is_test = true, updated_at = now()
  from public.payments p
 where p.id = e.payment_id
   and e.is_test = false
   and (p.mode = 'test' or p.is_test_webhook);


-- ── 2. Where the money actually is ─────────────────────────────────────────
--
-- Four different numbers get called "revenue" in a payment-gateway business
-- and confusing them is how a month stops reconciling:
--
--   gross            what students were charged
--   fees             what Kashier kept
--   net_settled      gross − refunds − fees: what Kashier owes you
--   transferred      what Kashier has actually sent to your bank
--   awaiting_payout  net_settled − transferred − in_flight: still at Kashier
--
-- `awaiting_payout` is computed from our own records. `kashier_account
-- .available_balance` is Kashier's answer to the same question; the payouts
-- page shows both, because a gap between them is the first sign that a
-- transfer or a transaction was missed.
--
-- Test-mode and test-webhook traffic is excluded throughout, for the same
-- reason it is excluded from the ledger.

create or replace view public.v_money_position
with (security_invoker = on) as
with charged as (
  select
    p.mode,
    coalesce(sum(p.amount) filter (
      where p.event in ('pay', 'capture')), 0)                       as gross,
    coalesce(sum(p.amount) filter (
      where p.event in ('refund', 'reversal')), 0)                   as refunded,
    coalesce(sum(coalesce(p.fees, 0)) filter (
      where p.event in ('pay', 'capture')), 0)                       as fees,
    coalesce(sum(coalesce(p.settled_amount, p.amount, 0)) filter (
      where p.event in ('pay', 'capture')), 0)                       as settled_in,
    coalesce(sum(coalesce(p.settled_amount, p.amount, 0)) filter (
      where p.event in ('refund', 'reversal')), 0)                   as settled_out,
    count(*) filter (where p.event in ('pay', 'capture'))            as payments_count
  from public.payments p
  where p.status = 'SUCCESS'
    and not p.is_test_webhook
  group by p.mode
),
moved as (
  select
    po.mode,
    coalesce(sum(po.amount) filter (
      where po.event in ('TRANSFERRED', 'PARTIALLY_TRANSFERRED')), 0) as transferred,
    coalesce(sum(po.amount) filter (
      where po.event in ('INITIATED', 'IN_TRANSIT')), 0)              as in_flight,
    coalesce(sum(po.amount) filter (where po.event = 'FAILED'), 0)    as failed,
    count(*) filter (
      where po.event in ('TRANSFERRED', 'PARTIALLY_TRANSFERRED'))     as transfers_count,
    max(po.transfer_date) filter (
      where po.event = 'TRANSFERRED')                                 as last_transfer_at
  from public.payouts po
  group by po.mode
),
modes as (
  select unnest(enum_range(null::public.kashier_mode)) as mode
)
select
  m.mode,
  coalesce(c.gross, 0)                                       as gross,
  coalesce(c.refunded, 0)                                    as refunded,
  coalesce(c.fees, 0)                                        as fees,
  (coalesce(c.settled_in, 0) - coalesce(c.settled_out, 0))   as net_settled,
  coalesce(c.payments_count, 0)                              as payments_count,
  coalesce(t.transferred, 0)                                 as transferred,
  coalesce(t.in_flight, 0)                                   as in_flight,
  coalesce(t.failed, 0)                                      as failed,
  coalesce(t.transfers_count, 0)                             as transfers_count,
  t.last_transfer_at,
  (coalesce(c.settled_in, 0) - coalesce(c.settled_out, 0)
     - coalesce(t.transferred, 0) - coalesce(t.in_flight, 0)) as awaiting_payout,
  (select ka.available_balance from public.kashier_account ka where ka.mode = m.mode)
                                                             as kashier_reported_balance,
  (select ka.synced_at from public.kashier_account ka where ka.mode = m.mode)
                                                             as kashier_synced_at
from modes m
left join charged c on c.mode = m.mode
left join moved   t on t.mode = m.mode;

comment on view public.v_money_position is
  'One row per mode: what was charged, what Kashier kept in fees, what it owes, '
  'what it has transferred, and what is still sitting there. Excludes test '
  'deliveries. Always returns a row per mode, so an empty account reads as '
  'zeros rather than as a missing row.';


-- ── 3. Has this particular payment been paid out? ──────────────────────────
--
-- Kashier's Payout API gives a transfer an amount and a date, and no list of
-- the transactions it covers, so per-payment attribution is not a fact that
-- can be looked up. What CAN be stated is a FIFO position: settlements are
-- paid out oldest-first, so once the total transferred passes a payment's
-- place in the queue, that payment's money has left Kashier.
--
-- This is an ESTIMATE and the UI labels it as one. It is right in aggregate
-- and right for every payment except those straddling a transfer boundary,
-- which is exactly what `partially_paid_out` marks.

create or replace view public.v_payment_payout_status
with (security_invoker = on) as
with settled as (
  select
    p.id            as payment_id,
    p.mode,
    p.transaction_id,
    p.transaction_date,
    coalesce(p.settled_amount, p.amount, 0) as net,
    sum(coalesce(p.settled_amount, p.amount, 0)) over (
      partition by p.mode
      order by p.transaction_date nulls last, p.id
      rows between unbounded preceding and current row
    ) as cumulative_net
  from public.payments p
  where p.status = 'SUCCESS'
    and p.event in ('pay', 'capture')
    and not p.is_test_webhook
),
moved as (
  select
    mode,
    coalesce(sum(amount) filter (
      where event in ('TRANSFERRED', 'PARTIALLY_TRANSFERRED')), 0) as transferred
  from public.payouts
  group by mode
)
select
  s.payment_id,
  s.mode,
  s.transaction_id,
  s.transaction_date,
  s.net,
  s.cumulative_net,
  coalesce(m.transferred, 0) as transferred_to_date,
  case
    when s.cumulative_net <= coalesce(m.transferred, 0)            then 'paid_out'
    when s.cumulative_net - s.net < coalesce(m.transferred, 0)     then 'partially_paid_out'
    else 'at_kashier'
  end as payout_status
from settled s
left join moved m on m.mode = s.mode;

comment on view public.v_payment_payout_status is
  'FIFO estimate of whether a payment has left Kashier. Kashier does not say '
  'which transactions a transfer covered, so this infers it from settlement '
  'order. Correct in aggregate; only payments straddling a transfer boundary '
  'are ambiguous, and those are marked partially_paid_out.';


-- ── 4. The whole chain, one row per order ──────────────────────────────────
--
-- ukkera sells the course → Kashier takes the money → Kashier transfers it on.
-- Each stage can fail independently and each has its own vocabulary, so this
-- view puts all three in one row with one shared verdict per stage. It is what
-- the Journey page reads.

create or replace view public.v_order_journey
with (security_invoker = on) as
with payments_for_sub as (
  select
    m.subscription_id,
    count(*)                                          as payments_count,
    sum(p.amount)                                     as paid_gross,
    sum(coalesce(p.settled_amount, p.amount, 0))      as paid_settled,
    sum(coalesce(p.fees, 0))                          as paid_fees,
    max(p.transaction_date)                           as last_payment_at,
    (array_agg(p.transaction_id order by p.transaction_date desc nulls last))[1]
                                                      as latest_transaction_id,
    (array_agg(p.mode order by p.transaction_date desc nulls last))[1]
                                                      as latest_mode,
    (array_agg(p.method order by p.transaction_date desc nulls last))[1]
                                                      as latest_method,
    (array_agg(m.match_method order by p.transaction_date desc nulls last))[1]
                                                      as match_method,
    -- 'paid_out' only when EVERY payment on the order has cleared, so a
    -- part-transferred order never reads as fully banked.
    min(case ps.payout_status
          when 'at_kashier'         then 1
          when 'partially_paid_out' then 2
          when 'paid_out'           then 3
        end)                                          as payout_rank
  from public.v_payment_matches m
  join public.payments p on p.id = m.payment_id
  left join public.v_payment_payout_status ps on ps.payment_id = p.id
  where p.status = 'SUCCESS'
    and p.event in ('pay', 'capture')
    and not p.is_test_webhook
    and m.subscription_id is not null
  group by m.subscription_id
)
select
  s.id                                        as subscription_id,
  s.order_id,
  s.created_at                                as ordered_at,
  s.source                                    as order_source,
  st.id                                       as student_id,
  st.name                                     as student_name,
  st.phone                                    as student_phone,
  c.name                                      as course_name,
  pk.name                                     as package_name,

  f.total_due,
  f.total_paid,
  f.remaining,
  f.payment_status,

  coalesce(pf.payments_count, 0)              as kashier_payments,
  pf.paid_gross,
  pf.paid_settled,
  pf.paid_fees,
  pf.last_payment_at,
  pf.latest_transaction_id,
  pf.latest_mode,
  pf.latest_method,
  coalesce(pf.match_method, 'none')           as match_method,

  -- Stage 1: did ukkera send us the order? Always yes if the row exists.
  -- Stage 2: did Kashier take money for it?
  case
    when pf.subscription_id is null then 'not_paid'
    when coalesce(f.remaining, 0) > 0 then 'part_paid'
    else 'paid'
  end                                         as gateway_stage,

  -- Stage 3: has that money reached the bank?
  case
    when pf.subscription_id is null then 'none'
    when pf.payout_rank = 3 then 'paid_out'
    when pf.payout_rank = 2 then 'partially_paid_out'
    else 'at_kashier'
  end                                         as payout_stage

from public.subscriptions s
left join public.students  st on st.id = s.student_id
left join public.courses   c  on c.id  = s.course_id
left join public.packages  pk on pk.id = s.package_id
left join public.v_subscription_financials f on f.subscription_id = s.id
left join payments_for_sub pf on pf.subscription_id = s.id;

comment on view public.v_order_journey is
  'One row per ukkera order carrying all three stages: ordered, paid through '
  'Kashier, transferred to the bank. gateway_stage and payout_stage are the '
  'two verdicts the Journey page renders.';


grant select on
  public.v_money_position,
  public.v_payment_payout_status,
  public.v_order_journey
to authenticated;
