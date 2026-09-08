-- 0024_kashier_holding_wallet.sql
--
-- The bank wallet was showing the gross amount of every payment the moment it
-- was collected. Two things wrong with that, both spotted by the person
-- reading their own dashboard:
--
--   1. The money is not in the bank. It is at Kashier until a payout runs.
--   2. When it does arrive it will be the net, not the gross — Kashier keeps
--      its fee, the VAT on that fee, and the flat bank fee.
--
-- The cause: the bank account carried is_kashier_default and was standing in
-- as the gateway balance. Those are two different places, and money genuinely
-- sits in each, so each gets a wallet:
--
--   payment collected   revenue      gross -> Kashier wallet
--                       expense      fees  -> Kashier wallet
--   payout transferred  transfer_out net   -> Kashier wallet
--                       transfer_in  net   -> bank wallet
--
-- Kashier's wallet then reads what Kashier actually holds (90.84 on the first
-- payment, matching "still at Kashier"), the bank reads what actually reached
-- the bank (0, because nothing has been transferred), and the fee lands in the
-- P&L instead of being tracked only alongside it.
--
-- Modelling the payout as a transfer pair rather than revenue matters: the
-- money was already counted as revenue when it was collected, and counting it
-- again on arrival would double the year's income.

-- A payment produces two entries now, so one-per-payment is too narrow.
drop index if exists public.ledger_entries_payment_uniq;
create unique index ledger_entries_payment_uniq
  on public.ledger_entries (payment_id, entry_type)
  where payment_id is not null and voided_at is null;

-- Where a payout lands. Explicit, rather than "the first bank account found".
alter table public.wallets
  add column if not exists is_payout_destination boolean not null default false;

comment on column public.wallets.is_payout_destination is
  'The bank account Kashier pays out to. Receives the transfer_in half when a payout settles.';
comment on column public.wallets.is_kashier_default is
  'The wallet holding money still at Kashier. Not a bank account — the gateway balance.';

do $$
declare
  v_bank uuid;
  v_kashier uuid;
begin
  select id into v_bank
    from public.wallets
   where is_kashier_default and is_active
   order by sort_order, created_at
   limit 1;

  select id into v_kashier
    from public.wallets where name_key = upper(btrim('رصيد كاشير'));

  if v_kashier is null then
    insert into public.wallets (name, type, is_active, opening_balance, sort_order, notes)
    values ('رصيد كاشير', 'digital', true, 0, -1,
            'الفلوس اللي لسه عند كاشير قبل ما تتحول للبنك. مش حساب بنكي.')
    returning id into v_kashier;
  end if;

  update public.wallets set is_kashier_default = false where is_kashier_default;
  update public.wallets set is_kashier_default = true where id = v_kashier;

  if v_bank is not null then
    update public.wallets set is_payout_destination = true where id = v_bank;
  end if;
end $$;

-- app.sync_payment_to_ledger now writes the revenue entry to the Kashier
-- wallet and adds an expense entry for fees + VAT + bank fee against the same
-- wallet, on collection only — a refund does not return the fee, so reversing
-- one must not credit it back. Full body in the applied migration
-- `payment_and_payout_ledger_two_wallets`.
--
-- app.sync_payout_to_ledger is new, with a trigger on payouts: a TRANSFERRED
-- or PARTIALLY_TRANSFERRED payout writes a transfer_out/transfer_in pair keyed
-- on the payout id, so re-syncing the same transfer updates its own pair
-- rather than creating a second one.
--
-- v_dashboard_kpis: net_after_everything was subtracting gateway fees twice
-- once they became ledger expenses — inside m.expenses and again from
-- g.fees_total. Fixed, plus other_expenses / at_kashier_wallet / in_own_wallets
-- so the overview can separate the fee from running costs, and money still at
-- the gateway from money that has actually arrived. See
-- `kpis_stop_double_counting_gateway_fees`.
--
-- Verified on the live payment: Kashier wallet 90.84 (in 100.00, out 9.16),
-- bank 0.00, revenue 100.00, net 90.84, wallets_total 90.84 with no double
-- count. A dry-run payout of 90.84 inside a rolled-back transaction moved the
-- balance to the bank and left revenue untouched.
