-- Every reporting surface now separates the two numbers that were being
-- conflated. `revenue` keeps its name and its position but changes meaning to
-- NET — the figure that reaches us — because that is what the word should have
-- meant all along. The gross figure gets its own honest name next to it.
--
-- CAUTION, learned the hard way in this file: `create or replace view` DISCARDS
-- reloptions. Every view replaced below came back with security_invoker off the
-- first time this ran, which silently turns RLS off for it. The `alter view`
-- block at the end is not tidying — it is the other half of the statement.

-- --------------------------------------------------------------------------
-- v_ledger: a Kashier row answers the whole question by itself.
-- What the student paid, what was taken, what is left.
-- --------------------------------------------------------------------------
create or replace view public.v_ledger as
select e.id, e.entry_type, e.amount, e.occurred_at, e.description, e.category,
       e.reference, e.metadata, e.is_test, e.transfer_group_id, e.voided_at,
       e.void_reason, e.created_at,
       app.wallet_delta(e.entry_type, e.amount) as wallet_delta,
       app.pnl_revenue(e.entry_type, e.amount)  as revenue_effect,
       app.pnl_expense(e.entry_type, e.amount)  as expense_effect,
       e.wallet_id, w.name as wallet_name, w.type as wallet_type,
       e.student_id, st.name as student_name, st.phone as student_phone,
       e.course_id, c.name as course_name,
       e.subscription_id, sub.order_id as subscription_order_id,
       e.payment_id, p.transaction_id as kashier_transaction_id,
       p.method as payment_method, p.status as payment_status,
       app.pnl_fee(e.entry_type, e.amount) as fee_effect,
       -- Read off the payment, not off the entry's own metadata: a fee
       -- schedule correction must reach a row already written.
       case when p.event in ('pay', 'capture')
            then abs(coalesce(p.amount, 0)) end as payment_gross,
       case when p.event in ('pay', 'capture')
            then coalesce(p.fees, 0) + coalesce(p.vat, 0)
               + app.bank_fee_at(p.mode, p.transaction_date) end as payment_fees,
       case when p.event in ('pay', 'capture')
            then abs(coalesce(p.amount, 0))
               - (coalesce(p.fees, 0) + coalesce(p.vat, 0)
                  + app.bank_fee_at(p.mode, p.transaction_date)) end as payment_net
  from public.ledger_entries e
  join public.wallets w on w.id = e.wallet_id
  left join public.students st on st.id = e.student_id
  left join public.courses c on c.id = e.course_id
  left join public.subscriptions sub on sub.id = e.subscription_id
  left join public.payments p on p.id = e.payment_id;

-- --------------------------------------------------------------------------
-- v_finance_daily / _monthly
-- net_profit is unchanged by this migration and that is the proof it is only
-- a reclassification: gross - fees - expenses = (gross - fees) - expenses.
-- --------------------------------------------------------------------------
create or replace view public.v_finance_daily as
select (occurred_at at time zone 'Africa/Cairo')::date as day,
       sum(app.pnl_revenue(entry_type, amount))
         - sum(app.pnl_fee(entry_type, amount))          as revenue,
       sum(app.pnl_expense(entry_type, amount))          as expenses,
       sum(app.pnl_revenue(entry_type, amount))
         - sum(app.pnl_fee(entry_type, amount))
         - sum(app.pnl_expense(entry_type, amount))      as net_profit,
       count(*) filter (where entry_type = 'revenue')     as revenue_entries,
       count(*) filter (where entry_type = 'expense')     as expense_entries,
       count(*) filter (where entry_type in ('refund', 'reversal')) as refund_entries,
       sum(app.pnl_revenue(entry_type, amount))          as student_payments,
       sum(app.pnl_fee(entry_type, amount))              as gateway_fees,
       count(*) filter (where entry_type = 'gateway_fee') as fee_entries
  from public.ledger_entries e
 where voided_at is null and not is_test
 group by 1;

create or replace view public.v_finance_monthly as
select date_trunc('month', day::timestamptz)::date as month,
       sum(revenue)          as revenue,
       sum(expenses)         as expenses,
       sum(net_profit)       as net_profit,
       sum(revenue_entries)  as revenue_entries,
       sum(expense_entries)  as expense_entries,
       sum(student_payments) as student_payments,
       sum(gateway_fees)     as gateway_fees
  from public.v_finance_daily
 group by 1;

create or replace view public.v_monthly_report as
select month,
       revenue,
       expenses,
       net_profit,
       revenue_entries as payments_count,
       expense_entries as expenses_count,
       student_payments as payments_total,
       student_payments,
       gateway_fees
  from public.v_finance_monthly m;

-- --------------------------------------------------------------------------
-- breakdowns: a course's revenue is what that course actually earned, so the
-- fees charged on its payments belong to it too.
-- --------------------------------------------------------------------------
create or replace view public.v_revenue_by_course as
select date_trunc('month', (e.occurred_at at time zone 'Africa/Cairo')::date::timestamptz)::date as month,
       e.course_id,
       coalesce(c.name, 'غير محدد') as course_name,
       sum(app.pnl_revenue(e.entry_type, e.amount))
         - sum(app.pnl_fee(e.entry_type, e.amount)) as revenue,
       count(*) filter (where e.entry_type = 'revenue') as payments,
       sum(app.pnl_revenue(e.entry_type, e.amount)) as student_payments,
       sum(app.pnl_fee(e.entry_type, e.amount))     as gateway_fees
  from public.ledger_entries e
  left join public.courses c on c.id = e.course_id
 where e.voided_at is null and not e.is_test
   and e.entry_type in ('revenue', 'refund', 'reversal', 'gateway_fee')
 group by 1, 2, 3;

create or replace view public.v_revenue_by_university as
select date_trunc('month', (e.occurred_at at time zone 'Africa/Cairo'))::date as month,
       u.id as university_id,
       coalesce(u.name, 'غير محدد') as university_name,
       sum(app.pnl_revenue(e.entry_type, e.amount))
         - sum(app.pnl_fee(e.entry_type, e.amount)) as revenue,
       count(*) filter (where e.entry_type = 'revenue') as payments,
       sum(app.pnl_revenue(e.entry_type, e.amount)) as student_payments,
       sum(app.pnl_fee(e.entry_type, e.amount))     as gateway_fees
  from public.ledger_entries e
  left join public.courses c on c.id = e.course_id
  left join public.universities u on u.id = c.university_id
 where e.voided_at is null and not e.is_test
   and e.entry_type in ('revenue', 'refund', 'reversal', 'gateway_fee')
 group by 1, 2, 3;

-- The other half of every `create or replace view` above.
alter view public.v_ledger                set (security_invoker = on);
alter view public.v_finance_daily         set (security_invoker = on);
alter view public.v_finance_monthly       set (security_invoker = on);
alter view public.v_monthly_report        set (security_invoker = on);
alter view public.v_revenue_by_course     set (security_invoker = on);
alter view public.v_revenue_by_university set (security_invoker = on);
