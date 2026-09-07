-- 0005_views.sql
-- Reporting layer.
--
-- Every view is security_invoker so the caller's RLS applies. Without this a
-- view owned by postgres would happily hand an anon client the full payments
-- table, RLS on the base table notwithstanding.

-- ---------------------------------------------------------------------------
-- Money direction
-- ---------------------------------------------------------------------------
-- A single place that decides how each event affects revenue, so the KPI
-- cards, the charts and the CSV export can never disagree with each other.
--   pay / capture  -> money in
--   refund/reversal-> money out
--   authorize/void -> no movement (an authorize only holds funds)
-- Non-SUCCESS statuses never count.

create or replace function app.signed_amount(
  p_event public.kashier_txn_event,
  p_status public.txn_status,
  p_amount numeric
) returns numeric
language sql
immutable
parallel safe
set search_path = ''
as $$
  select case
    when p_status <> 'SUCCESS' then 0
    when p_event in ('pay','capture')    then coalesce(p_amount, 0)
    when p_event in ('refund','reversal') then -coalesce(p_amount, 0)
    else 0
  end
$$;

-- ---------------------------------------------------------------------------
-- Payment <-> subscription matching
-- ---------------------------------------------------------------------------
-- The ukkera order_id == Kashier merchantOrderId hypothesis lives here and
-- nowhere else. A manual override always beats the automatic match.

create view public.v_payment_matches
with (security_invoker = on) as
select
  p.id                                       as payment_id,
  coalesce(o.subscription_id, s.id)          as subscription_id,
  case
    when o.subscription_id is not null then 'override'
    when s.id is not null              then 'auto_order_key'
    else 'none'
  end                                        as match_method
from public.payments p
left join public.payment_subscription_overrides o on o.payment_id = p.id
left join public.subscriptions s
       on s.order_key = p.merchant_order_key
      and o.subscription_id is null;

-- ---------------------------------------------------------------------------
-- The table the dashboard actually reads
-- ---------------------------------------------------------------------------

create view public.v_payments_enriched
with (security_invoker = on) as
select
  p.id, p.transaction_id, p.kashier_order_id, p.merchant_order_id, p.order_reference,
  p.event, p.status, p.mode,
  p.amount, p.currency, p.settled_amount, p.fees, p.vat,
  app.signed_amount(p.event, p.status, p.amount) as signed_amount,
  p.method, p.channel, p.card_brand, p.masked_card, p.apikey_name,
  p.transaction_date, p.response_code, p.response_message,
  p.is_test_webhook, p.created_at, p.updated_at,
  m.subscription_id,
  m.match_method,
  sub.order_id       as subscription_order_id,
  sub.payment_date   as subscription_payment_date,
  st.id              as student_id,
  st.name            as student_name,
  st.phone           as student_phone,
  st.group_name      as student_group,
  st.university      as student_university,
  c.id               as course_id,
  c.name             as course_name,
  pk.id              as package_id,
  pk.name            as package_name
from public.payments p
join public.v_payment_matches m on m.payment_id = p.id
left join public.subscriptions sub on sub.id = m.subscription_id
left join public.students st on st.id = sub.student_id
left join public.courses  c  on c.id  = sub.course_id
left join public.packages pk on pk.id = sub.package_id;

-- ---------------------------------------------------------------------------
-- Reconciliation: the two directions of "something is missing"
-- ---------------------------------------------------------------------------

-- Money arrived in Kashier but no ukkera subscription explains it.
create view public.v_unmatched_payments
with (security_invoker = on) as
select p.*
from public.v_payments_enriched p
where p.subscription_id is null
  and p.status = 'SUCCESS'
  and p.event in ('pay','capture');

-- ukkera recorded an order but no successful Kashier payment backs it.
create view public.v_unpaid_subscriptions
with (security_invoker = on) as
select
  s.id, s.order_id, s.amount, s.payment_date, s.created_at,
  st.name as student_name, st.phone as student_phone,
  c.name  as course_name
from public.subscriptions s
left join public.students st on st.id = s.student_id
left join public.courses  c  on c.id  = s.course_id
where not exists (
  select 1
  from public.payments p
  where p.merchant_order_key = s.order_key
    and p.status = 'SUCCESS'
    and p.event in ('pay','capture')
);

-- ---------------------------------------------------------------------------
-- Revenue, expenses, profit
-- ---------------------------------------------------------------------------

create view public.v_revenue_daily
with (security_invoker = on) as
select
  (p.transaction_date at time zone 'Africa/Cairo')::date as day,
  p.mode,
  sum(app.signed_amount(p.event, p.status, p.amount))         as gross,
  sum(app.signed_amount(p.event, p.status, p.settled_amount)) as settled,
  sum(coalesce(p.fees, 0)) filter (where p.status = 'SUCCESS' and p.event in ('pay','capture')) as fees,
  count(*) filter (where p.status = 'SUCCESS' and p.event in ('pay','capture')) as successful_payments,
  count(*) filter (where p.status = 'FAILURE')                                  as failed_payments,
  count(*) filter (where p.status = 'SUCCESS' and p.event = 'refund')           as refunds
from public.payments p
where p.transaction_date is not null
group by 1, 2;

create view public.v_expenses_daily
with (security_invoker = on) as
select e.spent_at as day, sum(e.amount) as expenses, count(*) as entries
from public.expenses e
group by 1;

-- Full outer join: a day with only expenses and a day with only revenue must
-- both appear, otherwise the profit chart silently drops days.
create view public.v_profit_daily
with (security_invoker = on) as
select
  coalesce(r.day, e.day)                                   as day,
  coalesce(r.gross, 0)                                     as revenue,
  coalesce(r.fees, 0)                                      as fees,
  coalesce(e.expenses, 0)                                  as expenses,
  coalesce(r.gross, 0) - coalesce(r.fees, 0) - coalesce(e.expenses, 0) as net_profit
from (select * from public.v_revenue_daily where mode = 'live') r
full outer join public.v_expenses_daily e on e.day = r.day;

create view public.v_revenue_monthly
with (security_invoker = on) as
select
  date_trunc('month', day)::date as month,
  sum(revenue)    as revenue,
  sum(fees)       as fees,
  sum(expenses)   as expenses,
  sum(net_profit) as net_profit
from public.v_profit_daily
group by 1;

-- ---------------------------------------------------------------------------
-- Payouts
-- ---------------------------------------------------------------------------

create view public.v_payout_summary
with (security_invoker = on) as
select
  po.mode,
  po.event,
  count(*)                  as transfers,
  sum(coalesce(po.amount,0)) as total_amount,
  max(po.transfer_date)      as latest_transfer_at
from public.payouts po
group by 1, 2;

-- ---------------------------------------------------------------------------
-- Pipeline health — the page to open when "I never got the webhook"
-- ---------------------------------------------------------------------------

create view public.v_ingest_health
with (security_invoker = on) as
select 'kashier' as pipeline, state::text, count(*) as events,
       max(received_at) as latest_at, sum(duplicate_count) as duplicates
from public.kashier_events_raw group by 1, 2
union all
select 'ukkera', state::text, count(*), max(received_at), sum(duplicate_count)
from public.ukkera_events_raw group by 1, 2;

-- ---------------------------------------------------------------------------
-- KPI header
-- ---------------------------------------------------------------------------

create view public.v_dashboard_kpis
with (security_invoker = on) as
select
  (select coalesce(sum(app.signed_amount(event, status, amount)), 0)
     from public.payments where mode = 'live')                              as revenue_all_time,
  (select coalesce(sum(app.signed_amount(event, status, amount)), 0)
     from public.payments
    where mode = 'live'
      and transaction_date >= date_trunc('month', now() at time zone 'Africa/Cairo')) as revenue_this_month,
  (select coalesce(sum(amount), 0) from public.expenses)                    as expenses_all_time,
  (select count(*) from public.students)                                    as students_total,
  (select count(*) from public.subscriptions)                               as subscriptions_total,
  (select count(*) from public.v_unmatched_payments)                        as unmatched_payments,
  (select count(*) from public.v_unpaid_subscriptions)                      as unpaid_subscriptions,
  (select coalesce(sum(coalesce(amount,0)), 0) from public.payouts
    where mode = 'live' and event = 'TRANSFERRED')                          as payouts_transferred,
  (select coalesce(sum(coalesce(amount,0)), 0) from public.payouts
    where mode = 'live' and event = 'INITIATED')                            as payouts_in_flight,
  (select count(*) from public.kashier_events_raw where state = 'failed')   as failed_ingest_events;
