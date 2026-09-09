-- A student paying in instalments has one question attached to them that the
-- list could not answer: when is the next payment, and how much. Everything
-- needed was already stored — `subscription_installments` holds the schedule,
-- and the ledger holds what has been paid against it — but nothing joined the
-- two, so the answer lived in whoever remembered it.
--
-- Two sources, because instalments arrive two ways in this business:
--
--   * A subscription with a SCHEDULE. The next instalment is the first one the
--     payments have not covered yet. Not the first unpaid ROW — the first row
--     the money has not reached, which is a different thing the moment someone
--     pays 150 against three instalments of 100.
--   * A PLAN, where each instalment is bought separately on ukkera and the
--     next one has not been bought yet. Nothing in the data can know when it
--     is due, so that date is entered, exactly like the plan's total price.

alter table public.installment_plans
  add column if not exists next_due_date date;

comment on column public.installment_plans.next_due_date is
  'When the next instalment is expected. Entered, not derived: the instalment '
  'has not been purchased yet, so no row anywhere implies a date. NULL means '
  'not agreed rather than not due.';

-- ---------------------------------------------------------------------------
-- Per subscription
-- ---------------------------------------------------------------------------
-- Two deliberate changes beyond the appended columns:
--
--   * The price and what is left of it are computed once, in `amt`, instead of
--     four times in the select list. Same numbers; one place they can be
--     wrong.
--   * "Overdue" now reads the next instalment's date when there is a schedule,
--     falling back to the subscription's own. Before, a subscription with a
--     schedule was judged against a single date that the schedule had already
--     superseded — so a plan whose second instalment was three weeks late
--     still read as `partial`.
--   * Today is Cairo's today. The database runs in UTC, so between midnight
--     and 2am `current_date` was yesterday, and a payment due that morning
--     spent two hours not being overdue.
create or replace view public.v_subscription_financials as
select s.id as subscription_id,
       s.order_id,
       s.student_id,
       s.course_id,
       s.package_id,
       s.created_at as enrolled_at,
       s.due_date,
       s.installment_count,
       amt.total_due,
       coalesce(paid.total, 0)::numeric(14,2) as total_paid,
       amt.remaining,
       paid.last_payment_at,
       paid.payments_count,
       case
         when amt.total_due <= 0 then
           case when coalesce(paid.total, 0) > 0 then 'paid' else 'unknown' end
         when coalesce(paid.total, 0) >= amt.total_due then 'paid'
         when coalesce(nd.due_date, s.due_date) is not null
          and coalesce(nd.due_date, s.due_date) < (now() at time zone 'Africa/Cairo')::date
           then 'overdue'
         when coalesce(paid.total, 0) > 0 then 'partial'
         else 'unpaid'
       end as payment_status,
       s.plan_id,
       s.plan_kind,
       s.ukkera_transfer_id,
       s.merchant_order_key,
       -- Appended: the next instalment, and nothing when there is not one.
       nd.seq as next_due_seq,
       case when amt.remaining > 0 then coalesce(nd.due_date, s.due_date) end
         as next_due_date,
       case when amt.remaining > 0 then coalesce(nd.amount, amt.remaining) end
         as next_due_amount,
       -- Negative is late. Computed here rather than in the browser: whether a
       -- payment is overdue must not depend on the viewer's clock being right.
       case when amt.remaining > 0 and coalesce(nd.due_date, s.due_date) is not null
            then coalesce(nd.due_date, s.due_date)
                 - (now() at time zone 'Africa/Cairo')::date
       end as next_due_in_days
  from public.subscriptions s
  left join public.packages pk on pk.id = s.package_id
  left join lateral (
    select sum(app.pnl_revenue(e.entry_type, e.amount))               as total,
           max(e.occurred_at) filter (where e.entry_type = 'revenue') as last_payment_at,
           count(*) filter (where e.entry_type = 'revenue')           as payments_count
      from public.ledger_entries e
     where e.subscription_id = s.id and e.voided_at is null and not e.is_test
  ) paid on true
  cross join lateral (
    select coalesce(s.total_due, pk.price, s.amount, 0)::numeric(14,2) as total_due,
           greatest(coalesce(s.total_due, pk.price, s.amount, 0)
                    - coalesce(paid.total, 0), 0)::numeric(14,2)       as remaining
  ) amt
  -- The first instalment the money has not reached. `cum` is the schedule
  -- totalled up to and including that row, so the comparison is against what
  -- has been paid in total rather than against one instalment at a time — and
  -- the amount shown is what is left of that instalment, not its face value.
  left join lateral (
    select x.seq, x.due_date,
           least(x.amount, x.cum - coalesce(paid.total, 0))::numeric(14,2) as amount
      from (
        select i.seq, i.due_date, i.amount,
               sum(i.amount) over (order by i.seq
                                   rows between unbounded preceding and current row) as cum
          from public.subscription_installments i
         where i.subscription_id = s.id
      ) x
     where x.cum > coalesce(paid.total, 0)
     order by x.seq
     limit 1
  ) nd on true;

alter view public.v_subscription_financials set (security_invoker = on);

-- ---------------------------------------------------------------------------
-- Per plan
-- ---------------------------------------------------------------------------
create or replace view public.v_installment_plans as
select
  pl.id as plan_id,
  pl.student_id,
  st.name  as student_name,
  st.phone as student_phone,
  pl.course_id,
  c.name   as course_name,
  pl.package_id,
  pk.name  as package_name,
  pl.installment_count,
  pl.total_due,
  coalesce(paid.total, 0)::numeric(14,2)  as total_paid,
  case when pl.total_due is null then null
       else greatest(pl.total_due - coalesce(paid.total, 0), 0)::numeric(14,2)
  end as remaining,
  coalesce(paid.payments_count, 0)                                  as installments_paid,
  greatest(pl.installment_count - coalesce(paid.payments_count, 0), 0) as installments_remaining,
  case
    when pl.total_due is null then null
    when greatest(pl.installment_count - coalesce(paid.payments_count, 0), 0) = 0 then null
    else round(greatest(pl.total_due - coalesce(paid.total, 0), 0)
               / greatest(pl.installment_count - coalesce(paid.payments_count, 0), 1), 2)
  end as next_installment_amount,
  paid.last_payment_at,
  pl.started_at,
  pl.closed_at,
  pl.notes,
  case
    when pl.closed_at is not null then 'closed'
    when pl.total_due is null     then 'unknown'
    when coalesce(paid.total, 0) >= pl.total_due then 'paid'
    when coalesce(paid.payments_count, 0) = 0    then 'unpaid'
    else 'partial'
  end as status,
  -- Appended. Only meaningful while the plan is open and unfinished: a date on
  -- a closed plan is a date nobody is waiting for.
  case when pl.closed_at is null
        and greatest(pl.installment_count - coalesce(paid.payments_count, 0), 0) > 0
       then pl.next_due_date end as next_due_date,
  case when pl.closed_at is null and pl.next_due_date is not null
        and greatest(pl.installment_count - coalesce(paid.payments_count, 0), 0) > 0
       then pl.next_due_date - (now() at time zone 'Africa/Cairo')::date
  end as next_due_in_days
from public.installment_plans pl
left join public.students st on st.id = pl.student_id
left join public.courses  c  on c.id  = pl.course_id
left join public.packages pk on pk.id = pl.package_id
left join lateral (
  select sum(app.pnl_revenue(e.entry_type, e.amount))                as total,
         count(*) filter (where e.entry_type = 'revenue')            as payments_count,
         max(e.occurred_at) filter (where e.entry_type = 'revenue')  as last_payment_at
    from public.ledger_entries e
    join public.subscriptions s on s.id = e.subscription_id
   where s.plan_id = pl.id and e.voided_at is null and not e.is_test
) paid on true;

alter view public.v_installment_plans set (security_invoker = on);
grant select on public.v_installment_plans to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- On the list
-- ---------------------------------------------------------------------------
create or replace view public.v_subscriptions_list as
select s.id as subscription_id,
       s.order_id,
       s.source,
       s.created_at as enrolled_at,
       s.payment_date,
       s.due_date,
       s.installment_count,
       s.amount as order_amount,
       s.total_due as price_override,
       st.id as student_id, st.name as student_name, st.phone as student_phone,
       st.phone_normalized as student_phone_normalized,
       c.id as course_id, c.name as course_name,
       pk.id as package_id, pk.name as package_name, pk.price as package_price,
       coalesce(f.total_due, 0) as total_due,
       coalesce(f.total_paid, 0) as total_paid,
       coalesce(f.remaining, 0) as remaining,
       f.payment_status,
       coalesce(f.payments_count, 0) as payments_count,
       f.last_payment_at,
       case when s.total_due is not null then 'override'
            when pk.price is not null then 'package'
            when s.amount is not null then 'order'
            else 'none' end as price_source,
       s.plan_kind,
       s.plan_id,
       s.ukkera_transfer_id,
       s.merchant_order_key,
       pl.total_due  as plan_total_due,
       pl.total_paid as plan_total_paid,
       pl.remaining  as plan_remaining,
       pl.installments_paid,
       pl.installment_count as plan_installment_count,
       pl.next_installment_amount,
       pl.status as plan_status,
       c.university_id, c.university_label, c.level, c.section, c.class_year, c.track,
       pk.kind as package_kind, pk.installment_seq, pk.chapter_name,
       c.track_id, tr.name as track_name, u.name as university_name,
       -- Appended. The plan's date wins when there is a plan: an instalment
       -- purchase's own subscription is already paid in full, so its own next
       -- due is empty and the debt belongs to the enrolment.
       coalesce(pl.next_due_date, f.next_due_date)        as next_due_date,
       coalesce(pl.next_installment_amount, f.next_due_amount) as next_due_amount,
       coalesce(pl.next_due_in_days, f.next_due_in_days)  as next_due_in_days,
       f.next_due_seq,
       kd.name    as plan_kind_name,
       kd.name_en as plan_kind_name_en
  from public.subscriptions s
  left join public.students st on st.id = s.student_id
  left join public.courses c on c.id = s.course_id
  left join public.tracks tr on tr.id = c.track_id
  left join public.universities u on u.id = c.university_id
  left join public.packages pk on pk.id = s.package_id
  left join public.plan_kinds kd on kd.code = s.plan_kind
  left join public.v_subscription_financials f on f.subscription_id = s.id
  left join public.v_installment_plans pl on pl.plan_id = s.plan_id;

alter view public.v_subscriptions_list set (security_invoker = on);
grant select on public.v_subscriptions_list to authenticated, service_role;
