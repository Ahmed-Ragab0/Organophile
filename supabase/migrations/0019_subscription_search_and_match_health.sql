-- 0019_subscription_search_and_match_health.sql
--
-- Two views, for two problems that were both "you cannot see it from here".
--
-- 1. Subscriptions could only be searched by order id, because the student,
--    course and package names live in joined tables and PostgREST cannot OR
--    across an embedded resource. Everything else was filtered in the browser
--    over a capped page, so a match on row 501 simply did not exist.
--
-- 2. The payments <-> subscriptions join is a hypothesis (see 0002_core_schema
--    line 6). It has never been anything but an assumption, because nothing
--    counted how often it actually holds.

-- ---------------------------------------------------------------------------
-- Subscriptions, flattened for search and filtering
-- ---------------------------------------------------------------------------
-- Flat columns only: every filter the list offers is then a plain PostgREST
-- predicate on one relation, which is what makes server-side search possible
-- at all. `security_invoker` keeps RLS on the underlying rows.

create or replace view public.v_subscriptions_list
with (security_invoker = on) as
select
  s.id                       as subscription_id,
  s.order_id,
  s.source,
  s.created_at               as enrolled_at,
  s.payment_date,
  s.due_date,
  s.installment_count,
  s.amount                   as order_amount,
  s.total_due                as price_override,

  st.id                      as student_id,
  st.name                    as student_name,
  st.phone                   as student_phone,
  st.phone_normalized        as student_phone_normalized,

  c.id                       as course_id,
  c.name                     as course_name,

  pk.id                      as package_id,
  pk.name                    as package_name,
  pk.price                   as package_price,

  -- The money side, already resolved by the financials view, so the list and
  -- the pricing page can never disagree about what a subscription is worth.
  coalesce(f.total_due, 0)   as total_due,
  coalesce(f.total_paid, 0)  as total_paid,
  coalesce(f.remaining, 0)   as remaining,
  f.payment_status,
  coalesce(f.payments_count, 0) as payments_count,
  f.last_payment_at,

  -- Where the price came from. Mirrors coalesce(total_due, package.price,
  -- amount, 0) so the UI can explain a figure instead of just printing it.
  case
    when s.total_due is not null then 'override'
    when pk.price    is not null then 'package'
    when s.amount    is not null then 'order'
    else 'none'
  end                        as price_source
from public.subscriptions s
left join public.students  st on st.id = s.student_id
left join public.courses   c  on c.id  = s.course_id
left join public.packages  pk on pk.id = s.package_id
left join public.v_subscription_financials f on f.subscription_id = s.id;

comment on view public.v_subscriptions_list is
  'One row per subscription with the student, course, package and money flattened, '
  'so the subscriptions list can search and filter server-side on one relation.';

-- ---------------------------------------------------------------------------
-- How often the order_id == merchantOrderId hypothesis actually holds
-- ---------------------------------------------------------------------------
-- Only settlement-shaped events count. A refund or a failed attempt not
-- matching says nothing about the hypothesis, and including them would move
-- the rate for reasons that have nothing to do with linking.

create or replace view public.v_payment_match_health
with (security_invoker = on) as
select
  m.mode,
  count(*)                                                  as payments,
  count(*) filter (where m.match_method = 'auto_order_key')  as auto_matched,
  count(*) filter (where m.match_method = 'override')        as manually_linked,
  count(*) filter (where m.match_method = 'none')            as unmatched,
  -- The number the design note has been waiting for. NULL rather than 0 when
  -- there is nothing to measure: a rate of 0% and "no evidence yet" are very
  -- different statements and must not look the same on screen.
  case
    when count(*) = 0 then null
    else round(
      100.0 * count(*) filter (where m.match_method = 'auto_order_key') / count(*), 1)
  end                                                       as auto_match_rate,
  min(m.transaction_date) filter (where m.match_method = 'none') as oldest_unmatched_at,
  max(m.transaction_date)                                   as latest_payment_at
from (
  select p.mode, p.transaction_date, v.match_method
  from public.payments p
  join public.v_payment_matches v on v.payment_id = p.id
  where p.event in ('pay', 'capture')
    and not (p.mode = 'test' or p.is_test_webhook)
) m
group by m.mode;

comment on view public.v_payment_match_health is
  'Auto-match rate for the ukkera order_id = Kashier merchantOrderId hypothesis, '
  'over live settlement events only. 100%% across a meaningful number of live '
  'payments is what turns the assumption in 0002_core_schema into a fact.';

grant select on
  public.v_subscriptions_list,
  public.v_payment_match_health
to authenticated;
