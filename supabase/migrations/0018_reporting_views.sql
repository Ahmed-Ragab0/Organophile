-- 0018 — reporting cuts that did not exist yet.
--
-- All month-keyed and live-only, matching the shape of the existing report
-- views (`v_revenue_by_course`, `v_expenses_by_category`) so the Reports page
-- can filter every one of them with the same month range.
--
-- `v_payouts_monthly` is the exception on mode: the payouts page is mode-aware,
-- so it carries `mode` rather than pinning to live.

-- How students actually pay. Card vs wallet vs bank matters because the fee
-- differs per method, so this carries the fee alongside the revenue.
create or replace view public.v_revenue_by_method
with (security_invoker = on) as
select
  (date_trunc('month', (p.transaction_date at time zone 'Africa/Cairo')))::date as month,
  coalesce(nullif(btrim(p.method), ''), 'غير محدد') as method,
  count(*) filter (where p.event in ('pay', 'capture'))          as payments,
  coalesce(sum(p.amount) filter (where p.event in ('pay', 'capture')), 0)        as revenue,
  coalesce(sum(coalesce(p.fees, 0)) filter (where p.event in ('pay', 'capture')), 0) as fees,
  coalesce(sum(coalesce(p.settled_amount, p.amount, 0)) filter (where p.event in ('pay', 'capture')), 0) as settled
from public.payments p
where p.status = 'SUCCESS'
  and not p.is_test_webhook
  and p.mode = 'live'
  and p.transaction_date is not null
group by 1, 2;

comment on view public.v_revenue_by_method is
  'Revenue and Kashier fees per payment method, per month. Live and non-test only, like every other money view.';

-- What Kashier charged, per month. Its own report because a fee rate creeping
-- up is invisible inside a revenue total.
create or replace view public.v_fees_monthly
with (security_invoker = on) as
select
  (date_trunc('month', (p.transaction_date at time zone 'Africa/Cairo')))::date as month,
  count(*) filter (where p.event in ('pay', 'capture'))                          as payments,
  coalesce(sum(p.amount) filter (where p.event in ('pay', 'capture')), 0)        as gross,
  coalesce(sum(coalesce(p.fees, 0)) filter (where p.event in ('pay', 'capture')), 0) as fees,
  coalesce(sum(coalesce(p.vat, 0)) filter (where p.event in ('pay', 'capture')), 0)  as vat,
  case
    when coalesce(sum(p.amount) filter (where p.event in ('pay', 'capture')), 0) > 0
      then round(
        100 * coalesce(sum(coalesce(p.fees, 0)) filter (where p.event in ('pay', 'capture')), 0)
        / sum(p.amount) filter (where p.event in ('pay', 'capture')), 2)
    else 0
  end as fee_rate_pct
from public.payments p
where p.status = 'SUCCESS'
  and not p.is_test_webhook
  and p.mode = 'live'
  and p.transaction_date is not null
group by 1;

comment on view public.v_fees_monthly is
  'Kashier fees per month with the effective rate, so a change in the fee schedule is visible.';

-- Transfers per month, so the payout side can be reported over a range like
-- everything else.
create or replace view public.v_payouts_monthly
with (security_invoker = on) as
select
  (date_trunc('month', (po.transfer_date at time zone 'Africa/Cairo')))::date as month,
  po.mode,
  count(*) filter (where po.event in ('TRANSFERRED', 'PARTIALLY_TRANSFERRED')) as transfers,
  coalesce(sum(po.amount) filter (where po.event in ('TRANSFERRED', 'PARTIALLY_TRANSFERRED')), 0) as transferred,
  coalesce(sum(po.amount) filter (where po.event in ('INITIATED', 'IN_TRANSIT')), 0) as in_flight,
  coalesce(sum(po.amount) filter (where po.event = 'FAILED'), 0) as failed
from public.payouts po
where po.transfer_date is not null
group by 1, 2;

comment on view public.v_payouts_monthly is
  'Transfers per month and mode. Not filtered to live, because the payouts page is mode-aware.';

grant select on
  public.v_revenue_by_method,
  public.v_fees_monthly,
  public.v_payouts_monthly
to authenticated;
