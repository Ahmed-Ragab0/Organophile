-- 0039 — record the settlement, and do not attribute money that was never ours.
--
-- 0038 established that Kashier's `/v2/transfers` never lists a settlement to
-- your own bank: it is the bulk-transfer API, money a merchant sends to
-- recipients, and it answers `pagination.total: 0` here. The only record of a
-- settlement is the account endpoint — lastTransfer, lastTransferDate,
-- lastTransferId, lastTransferReference — so that is where the payout is read
-- from now.
--
-- Recording it naively would have been worse than not recording it.
-- `v_payment_payout_status` attributes transfers to payments oldest-first, and
-- `v_money_position` subtracts them from what is still owed. A 100.57 payout
-- would therefore have announced that مريم نادر's money had reached the bank.
-- It had not. That transfer moved money that predates this system entirely:
--
--   totalBalanceBeforeLastTransfer   292.08
--   lastTransfer                   − 100.57
--   totalBalance                   = 191.51  =  95.84 + 95.67, our two
--                                                settled payments, untouched
--
-- The transfer emptied exactly the part that was not ours. So Kashier was
-- already holding 100.57 for this merchant before our first payment, and that
-- opening balance has to come off the top of every attribution or the first
-- settlement of our own money gets counted twice.

alter table public.kashier_account
  add column if not exists opening_balance      numeric(14,2) not null default 0
    check (opening_balance >= 0),
  add column if not exists opening_balance_note text;

comment on column public.kashier_account.opening_balance is
  'What Kashier was already holding for this merchant before this system '
  'recorded its first payment. Not attributable to any payment here, so it is '
  'subtracted from transfers before they are matched against settlements.';

-- Pinned to the exact transfer the arithmetic above was verified against, so
-- re-running this against a different state cannot silently invent a figure.
update public.kashier_account
   set opening_balance = 100.57,
       opening_balance_note =
         'اتحسبت من كاشير نفسها: الرصيد قبل التحويل ٢٩٢٫٠٨ ناقص التحويل ١٠٠٫٥٧ '
         || 'بيساوي ١٩١٫٥١، وهو بالظبط ٩٥٫٨٤ + ٩٥٫٦٧ — الدفعتين المستقرتين '
         || 'بتوعنا. يعني التحويل شال بالضبط اللي مش بتاعنا.'
 where mode = 'live'
   and opening_balance = 0
   and raw_payload ->> 'lastTransferId' = '1788930748631';

-- ---------------------------------------------------------------------------
-- One definition of "transferred, and it was ours", used by both views so they
-- can never disagree about it.
-- ---------------------------------------------------------------------------
create or replace function app.transferred_ours(p_mode public.kashier_mode)
returns numeric language sql stable security definer set search_path = '' as $$
  select greatest(
    0,
    coalesce((select sum(po.amount) from public.payouts po
               where po.mode = p_mode
                 and po.event in ('TRANSFERRED', 'PARTIALLY_TRANSFERRED')), 0)
    - coalesce((select ka.opening_balance from public.kashier_account ka
                 where ka.mode = p_mode), 0)
  )::numeric(14,2)
$$;

comment on function app.transferred_ours is
  'Transfers out of Kashier, minus the balance it was already holding before '
  'this system recorded anything. Attributing that opening balance to our own '
  'payments would report money as banked that never left the gateway.';

grant execute on function app.transferred_ours(public.kashier_mode) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- CAUTION — `create or replace view` DISCARDS reloptions, which silently
-- strips `security_invoker = on`. Neither statement below is finished until
-- its `alter view` follows. See 0028.
-- ---------------------------------------------------------------------------
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
         as kashier_opening_balance
  from modes m
  left join charged c on c.mode = m.mode
  left join moved t on t.mode = m.mode;
alter view public.v_money_position set (security_invoker = on);
grant select on public.v_money_position to authenticated, service_role;

-- FIFO attribution, against the transfers that could have carried our money.
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
)
select s.payment_id,
       s.mode,
       s.transaction_id,
       s.transaction_date,
       s.net,
       s.cumulative_net,
       app.transferred_ours(s.mode) as transferred_to_date,
       case when s.cumulative_net <= app.transferred_ours(s.mode) then 'paid_out'
            when (s.cumulative_net - s.net) < app.transferred_ours(s.mode)
              then 'partially_paid_out'
            else 'at_kashier' end as payout_status
  from settled s;
alter view public.v_payment_payout_status set (security_invoker = on);
grant select on public.v_payment_payout_status to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Run it on a schedule.
--
-- The account endpoint reports only the LAST transfer, so the gap between two
-- syncs is the window in which a settlement can be missed entirely. A button
-- somebody remembers to press is not a control; every quarter of an hour is.
--
-- The key lives in Vault rather than in this file. The schedule is created
-- first and tolerates its absence — storing the key is then the only step
-- left, and nothing has to be rebuilt around it.
-- ---------------------------------------------------------------------------
create extension if not exists pg_net with schema extensions;

create or replace function app.sync_kashier_payouts(p_mode text default 'live')
returns jsonb language plpgsql security definer set search_path = '' as $function$
declare
  v_key text;
  v_id  bigint;
begin
  select vs.decrypted_secret into v_key
    from vault.decrypted_secrets vs
   where vs.name = 'service_role_key'
   limit 1;

  if v_key is null or btrim(v_key) = '' then
    return jsonb_build_object('ok', false, 'reason', 'no_service_role_key');
  end if;

  select net.http_post(
    url := 'https://egaaigoplqinjvwtnhoo.supabase.co/functions/v1/kashier-sync-payouts?mode='
           || coalesce(p_mode, 'live'),
    body := '{}'::jsonb,
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || v_key,
      'Content-Type', 'application/json'),
    timeout_milliseconds := 20000
  ) into v_id;

  return jsonb_build_object('ok', true, 'request_id', v_id);
end;
$function$;

comment on function app.sync_kashier_payouts is
  'Asks the payout sync to run. Reads the service role key from Vault, so the '
  'key is never in a migration, a repo, or a log. Returns '
  '{ok:false, reason:"no_service_role_key"} rather than failing when it is not '
  'stored yet.';

select cron.unschedule('sync-kashier-payouts')
 where exists (select 1 from cron.job where jobname = 'sync-kashier-payouts');

select cron.schedule(
  'sync-kashier-payouts',
  '*/15 * * * *',
  $$ select app.sync_kashier_payouts('live') $$
);
