-- 0041 — compare like with like, now that the fee is back on the payment.
--
-- 0040 restored the 5 per payment. That immediately breaks the comparison the
-- money-position panel makes, and in a way that looks like a discrepancy rather
-- than a definition problem:
--
--   ours (awaiting_payout)          272.18   settled minus the bank fee
--   Kashier (total_balance)         191.51   settled, fee not taken yet
--   difference                       80.67   meaning nothing
--
-- The fee comes off when the balance moves to a bank account, so Kashier's
-- balance has not paid it. Comparing our after-fee figure against it is short
-- by 5 for every payment, for ever. Against the settled figure instead:
--
--   ours (awaiting_settled)         287.18
--   Kashier                         191.51
--   difference                       95.67  =  payment #3, still settling
--
-- One number, one meaning: `awaiting_settled` is what Kashier should be
-- holding; `awaiting_payout` is what we will end up with. The panel wants the
-- first, the accounts want the second, and they are not the same question.
--
-- CAUTION — `create or replace view` discards reloptions and silently strips
-- `security_invoker = on`. The `alter view` below is part of the statement.

create or replace view public.v_money_position as
with charged as (
  select p.mode,
         coalesce(sum(p.amount) filter (where p.event in ('pay','capture')), 0) as gross,
         coalesce(sum(p.amount) filter (where p.event in ('refund','reversal')), 0) as refunded,
         coalesce(sum(coalesce(p.fees, 0)) filter (where p.event in ('pay','capture')), 0) as fees,
         coalesce(sum(coalesce(p.vat, 0)) filter (where p.event in ('pay','capture')), 0) as vat,
         coalesce(sum(app.bank_fee_at(p.mode, p.transaction_date))
                  filter (where p.event in ('pay','capture')), 0) as bank_fees,
         coalesce(sum(coalesce(p.settled_amount, p.amount, 0))
                  filter (where p.event in ('pay','capture')), 0) as settled_in,
         coalesce(sum(coalesce(p.settled_amount, p.amount, 0))
                  filter (where p.event in ('refund','reversal')), 0) as settled_out,
         count(*) filter (where p.event in ('pay','capture')) as payments_count,
         max(p.transaction_date) as latest_payment_at,
         min(p.transaction_date) as first_payment_at
    from public.payments p
   where p.status = 'SUCCESS' and not p.is_test_webhook
   group by p.mode
), moved as (
  select po.mode,
         coalesce(sum(po.amount) filter (
           where po.event in ('TRANSFERRED','PARTIALLY_TRANSFERRED')), 0) as transferred,
         coalesce(sum(po.amount) filter (where po.event in ('INITIATED','IN_TRANSIT')), 0) as in_flight,
         coalesce(sum(po.amount) filter (where po.event = 'FAILED'), 0) as failed,
         count(*) filter (where po.event in ('TRANSFERRED','PARTIALLY_TRANSFERRED')) as transfers_count,
         max(po.transfer_date) filter (where po.event = 'TRANSFERRED') as last_transfer_at
    from public.payouts po
   group by po.mode
), modes as (
  select unnest(enum_range(null::public.kashier_mode)) as mode
)
select m.mode,
       coalesce(c.gross, 0) as gross,
       coalesce(c.refunded, 0) as refunded,
       coalesce(c.fees, 0) as fees,
       coalesce(c.settled_in, 0) - coalesce(c.settled_out, 0) - coalesce(c.bank_fees, 0)
         as net_settled,
       coalesce(c.payments_count, 0) as payments_count,
       -- What Kashier moved, all of it. Kept whole because it is a fact about
       -- Kashier, and the screen shows it beside the corrected figure.
       coalesce(t.transferred, 0) as transferred,
       coalesce(t.in_flight, 0) as in_flight,
       coalesce(t.failed, 0) as failed,
       coalesce(t.transfers_count, 0) as transfers_count,
       t.last_transfer_at,
       -- Only the part of it that could have been ours comes off what we are
       -- still owed.
       coalesce(c.settled_in, 0) - coalesce(c.settled_out, 0) - coalesce(c.bank_fees, 0)
         - app.transferred_ours(m.mode) - coalesce(t.in_flight, 0) as awaiting_payout,
       (select ka.total_balance from public.kashier_account ka where ka.mode = m.mode)
         as kashier_reported_balance,
       (select ka.synced_at from public.kashier_account ka where ka.mode = m.mode)
         as kashier_synced_at,
       coalesce(c.bank_fees, 0) as bank_fees,
       coalesce(c.fees, 0) + coalesce(c.vat, 0) + coalesce(c.bank_fees, 0) as total_fees,
       app.bank_fee_at(m.mode, now()) as bank_fee_current,
       coalesce(c.gross, 0) - coalesce(c.refunded, 0) - coalesce(c.fees, 0)
         - coalesce(c.vat, 0) - coalesce(c.bank_fees, 0) as net_revenue,
       coalesce(c.vat, 0) as vat,
       c.latest_payment_at,
       (select ka.available_balance from public.kashier_account ka where ka.mode = m.mode)
         as kashier_on_hold,
       (select ka.total_balance from public.kashier_account ka where ka.mode = m.mode)
         as kashier_total_balance,
       (select ka.payout_fees from public.kashier_account ka where ka.mode = m.mode)
         as kashier_payout_fees,
       (select coalesce(sum(p2.amount), 0)
          from public.payments p2, public.kashier_account ka2
         where p2.mode = m.mode and ka2.mode = m.mode and p2.status = 'SUCCESS'
           and not p2.is_test_webhook and p2.event in ('pay','capture')
           and p2.transaction_date > ka2.synced_at) as collected_since_sync,
       case when c.latest_payment_at is null then null
            else round(extract(epoch from now() - c.latest_payment_at) / 3600.0, 1)
       end as hours_since_latest_payment,
       coalesce(c.gross, 0) - coalesce(c.refunded, 0)
         - app.transferred_ours(m.mode) - coalesce(t.in_flight, 0) as awaiting_payout_gross,
       (select ka.available_balance from public.kashier_account ka where ka.mode = m.mode)
         as kashier_available,
       (select ka.raw_payload ->> '_accountsReturned' from public.kashier_account ka
         where ka.mode = m.mode) as kashier_accounts_returned,
       (select ka.last_transfer from public.kashier_account ka where ka.mode = m.mode)
         as kashier_last_transfer,
       (select ka.last_transfer_date from public.kashier_account ka where ka.mode = m.mode)
         as kashier_last_transfer_at,
       (select ka.raw_payload ->> 'lastTransferReference' from public.kashier_account ka
         where ka.mode = m.mode) as kashier_last_transfer_ref,
       c.first_payment_at as our_records_start,
       -- Appended, because a replaced view may only grow at the end.
       app.transferred_ours(m.mode) as transferred_ours,
       (select ka.opening_balance from public.kashier_account ka where ka.mode = m.mode)
         as kashier_opening_balance,
       -- What Kashier should still be holding, measured the way KASHIER
       -- measures it: settled_amount, before the bank fee. The fee is taken
       -- when the balance moves to a bank account, not when a payment settles,
       -- so subtracting it here would leave the comparison permanently short
       -- by 5 per payment. This is the figure the panel compares against
       -- `kashier_reported_balance`; `awaiting_payout` is what WE will end up
       -- with, which is a different question.
       coalesce(c.settled_in, 0) - coalesce(c.settled_out, 0)
         - app.transferred_ours(m.mode) - coalesce(t.in_flight, 0) as awaiting_settled
  from modes m
  left join charged c on c.mode = m.mode
  left join moved t on t.mode = m.mode;
alter view public.v_money_position set (security_invoker = on);
grant select on public.v_money_position to authenticated, service_role;
