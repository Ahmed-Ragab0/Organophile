-- The last two places holding Kashier's `settled_amount` as if it were the net.
--
-- Kashier calculates that figure before the flat bank fee it never mentions on
-- the transaction, so it is always 5 EGP above what arrives. On the order
-- journey — the page whose entire job is to follow money from ukkera to the
-- bank — "عند كاشير" read 191.51 against a true 181.51: exactly 2 × 5.
--
-- Same mistake, fourth and fifth occurrence. `settled_amount` is a figure
-- Kashier reports about itself, and it is never the answer to "what do I get".
-- The rule: any figure that claims to be net must run through
-- app.bank_fee_at.

-- --------------------------------------------------------------------------
-- The journey's own arithmetic. paid_settled and paid_fees stay for
-- compatibility and are marked deprecated in the types; paid_net is the one to
-- read.
-- --------------------------------------------------------------------------
create or replace view public.v_order_journey as
with payments_for_sub as (
  select m.subscription_id,
         count(*) as payments_count,
         sum(p.amount) as paid_gross,
         sum(coalesce(p.settled_amount, p.amount, 0)) as paid_settled,
         sum(coalesce(p.fees, 0)) as paid_fees,
         -- Everything withheld, and what survives it.
         sum(coalesce(p.fees, 0) + coalesce(p.vat, 0)
             + app.bank_fee_at(p.mode, p.transaction_date)) as paid_fees_total,
         sum(coalesce(p.amount, 0)
             - (coalesce(p.fees, 0) + coalesce(p.vat, 0)
                + app.bank_fee_at(p.mode, p.transaction_date))) as paid_net,
         max(p.transaction_date) as last_payment_at,
         (array_agg(p.transaction_id order by p.transaction_date desc nulls last))[1] as latest_transaction_id,
         (array_agg(p.mode order by p.transaction_date desc nulls last))[1] as latest_mode,
         (array_agg(p.method order by p.transaction_date desc nulls last))[1] as latest_method,
         (array_agg(m.match_method order by p.transaction_date desc nulls last))[1] as match_method,
         min(case ps.payout_status
               when 'at_kashier' then 1
               when 'partially_paid_out' then 2
               when 'paid_out' then 3
               else null end) as payout_rank
    from public.v_payment_matches m
    join public.payments p on p.id = m.payment_id
    left join public.v_payment_payout_status ps on ps.payment_id = p.id
   where p.status = 'SUCCESS' and p.event in ('pay', 'capture')
     and not p.is_test_webhook and m.subscription_id is not null
   group by m.subscription_id
)
select s.id as subscription_id,
       s.order_id,
       s.created_at as ordered_at,
       s.source as order_source,
       st.id as student_id,
       st.name as student_name,
       st.phone as student_phone,
       c.name as course_name,
       pk.name as package_name,
       f.total_due,
       f.total_paid,
       f.remaining,
       f.payment_status,
       coalesce(pf.payments_count, 0) as kashier_payments,
       pf.paid_gross,
       pf.paid_settled,
       pf.paid_fees,
       pf.last_payment_at,
       pf.latest_transaction_id,
       pf.latest_mode,
       pf.latest_method,
       coalesce(pf.match_method, 'none') as match_method,
       case when pf.subscription_id is null then 'not_paid'
            when coalesce(f.remaining, 0) > 0 then 'part_paid'
            else 'paid' end as gateway_stage,
       case when pf.subscription_id is null then 'none'
            when pf.payout_rank = 3 then 'paid_out'
            when pf.payout_rank = 2 then 'partially_paid_out'
            else 'at_kashier' end as payout_stage,
       pf.paid_fees_total,
       pf.paid_net,
       s.ukkera_transfer_id,
       s.plan_id,
       s.plan_kind
  from public.subscriptions s
  left join public.students st on st.id = s.student_id
  left join public.courses c on c.id = s.course_id
  left join public.packages pk on pk.id = s.package_id
  left join public.v_subscription_financials f on f.subscription_id = s.id
  left join payments_for_sub pf on pf.subscription_id = s.id;
alter view public.v_order_journey set (security_invoker = on);

-- --------------------------------------------------------------------------
-- And the place that decides WHICH payments a transfer covered.
--
-- This walks payments oldest-first and marks them paid out as the running total
-- is covered by what Kashier has actually transferred. It was running that
-- total on settled_amount while comparing it against real transfers, which are
-- net of the bank fee. Every payment inflated the running total by 5 EGP, so
-- payments stayed marked "at Kashier" after the money had reached the bank —
-- and the drift compounded down the list.
--
-- Both sides of the comparison now measure the same thing: money that moves.
-- --------------------------------------------------------------------------
create or replace view public.v_payment_payout_status as
with settled as (
  select p.id as payment_id,
         p.mode,
         p.transaction_id,
         p.transaction_date,
         coalesce(p.amount, 0)
           - (coalesce(p.fees, 0) + coalesce(p.vat, 0)
              + app.bank_fee_at(p.mode, p.transaction_date)) as net,
         sum(coalesce(p.amount, 0)
             - (coalesce(p.fees, 0) + coalesce(p.vat, 0)
                + app.bank_fee_at(p.mode, p.transaction_date)))
           over (partition by p.mode order by p.transaction_date, p.id
                 rows between unbounded preceding and current row) as cumulative_net
    from public.payments p
   where p.status = 'SUCCESS' and p.event in ('pay', 'capture')
     and not p.is_test_webhook
), moved as (
  select mode,
         coalesce(sum(amount) filter (
           where event in ('TRANSFERRED', 'PARTIALLY_TRANSFERRED')), 0) as transferred
    from public.payouts
   group by mode
)
select s.payment_id,
       s.mode,
       s.transaction_id,
       s.transaction_date,
       s.net,
       s.cumulative_net,
       coalesce(m.transferred, 0) as transferred_to_date,
       case when s.cumulative_net <= coalesce(m.transferred, 0) then 'paid_out'
            when (s.cumulative_net - s.net) < coalesce(m.transferred, 0) then 'partially_paid_out'
            else 'at_kashier' end as payout_status
  from settled s
  left join moved m on m.mode = s.mode;
alter view public.v_payment_payout_status set (security_invoker = on);
