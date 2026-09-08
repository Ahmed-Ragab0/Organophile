-- 0022_bank_fee_schedule.sql
--
-- Kashier now takes a flat bank fee per transaction on top of its own
-- percentage-plus-flat, and does not report it in the webhook payload:
-- `settlementInfo.settledAmount` still shows the pre-bank-fee figure. So it
-- has to be applied from our side, which makes it the one number in the
-- accounts that comes from a person rather than from the gateway.
--
-- Effective-dated rather than a constant, for a reason worth stating: the
-- payment on 8 Sep 2026 settled at 95.84 (100 − 3.65 fee − 0.51 VAT) with no
-- bank fee. A hardcoded 5 would silently restate it as 90.84 and disagree with
-- what Kashier actually reported for that transaction. Every figure is
-- therefore computed against the schedule row in force at that payment's own
-- transaction_date, so a fee change never travels backwards into a month that
-- was already reconciled.

create table if not exists public.kashier_fee_schedule (
  id                 uuid primary key default gen_random_uuid(),
  mode               public.kashier_mode not null,
  effective_from     timestamptz not null,
  bank_fee_flat      numeric(14,2) not null default 0 check (bank_fee_flat >= 0),
  -- A rate, not a boolean: 0 means no VAT, 0.14 means 14%. A VAT change is
  -- then a data edit rather than a code change.
  bank_fee_vat_rate  numeric(6,4) not null default 0 check (bank_fee_vat_rate >= 0),
  note               text,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  constraint kashier_fee_schedule_mode_from_uniq unique (mode, effective_from)
);

comment on table public.kashier_fee_schedule is
  'Fees Kashier charges that it does not report in the webhook payload. Effective-dated so a change never restates history.';

create index if not exists kashier_fee_schedule_lookup_idx
  on public.kashier_fee_schedule (mode, effective_from desc);

alter table public.kashier_fee_schedule enable row level security;

create policy kashier_fee_schedule_admin_read on public.kashier_fee_schedule
  for select to authenticated using (app.is_admin());
create policy kashier_fee_schedule_admin_write on public.kashier_fee_schedule
  for all to authenticated using (app.is_admin()) with check (app.is_admin());

grant select, insert, update, delete on public.kashier_fee_schedule to authenticated;

create trigger kashier_fee_schedule_touch_updated_at
  before update on public.kashier_fee_schedule
  for each row execute function app.touch_updated_at();

-- The fee in force for one mode at one instant, VAT included.
create or replace function app.bank_fee_at(p_mode public.kashier_mode, p_at timestamptz)
returns numeric
language sql
stable
parallel safe
set search_path = ''
as $$
  select coalesce((
    select round(s.bank_fee_flat * (1 + s.bank_fee_vat_rate), 2)
      from public.kashier_fee_schedule s
     where s.mode = p_mode
       and s.effective_from <= coalesce(p_at, now())
     order by s.effective_from desc
     limit 1
  ), 0)::numeric(14,2);
$$;

comment on function app.bank_fee_at(public.kashier_mode, timestamptz) is
  'The unreported bank fee in force for that mode at that instant. Zero when no schedule row applies yet, so an unconfigured system never invents a deduction.';

-- Seeded from the moment of creation, which is rarely the moment the fee
-- actually started — the payouts page exposes the date for exactly that
-- reason.
insert into public.kashier_fee_schedule (mode, effective_from, bank_fee_flat, bank_fee_vat_rate, note)
select m, now(), 5.00, 0,
       'رسوم بنك ثابتة على كل عملية — كاشير مش بتبعتها في الـ payload. عدّل تاريخ السريان لو الرسم بدأ قبل كده.'
from unnest(array['live','test']::public.kashier_mode[]) m
on conflict (mode, effective_from) do nothing;

-- ---------------------------------------------------------------------------
-- Applied to the three views that state what the money is
-- ---------------------------------------------------------------------------
-- The full bodies are in the applied migrations
-- `money_position_includes_bank_fees`, `fees_monthly_carries_bank_fee` and
-- `payments_enriched_carries_bank_fee`. What each changed:
--
--   v_money_position     bank_fees / total_fees / bank_fee_current appended;
--                        net_settled and awaiting_payout now net of the bank
--                        fee, because "owed to you" only means anything if it
--                        reconciles against a bank statement.
--
--   v_fees_monthly       bank_fees, total_fees and effective_fee_rate_pct
--                        appended. Kashier's reported fee and the bank fee are
--                        separate columns: one is checkable against the
--                        payload, the other is ours. The effective rate is the
--                        one that bites — a flat 5 on a 50 EGP payment is
--                        14.18%, against a headline 4.16%.
--
--   v_payments_enriched  bank_fee and net_after_bank_fee appended, so a single
--                        payment row can show what it actually netted.
--
-- Charged on successful pay/capture only. A refund does not hand the bank fee
-- back, so refunding must not credit one either.

-- ---------------------------------------------------------------------------
-- Follow-ups from reviewing the first real payment against Kashier's dashboard
-- ---------------------------------------------------------------------------
--
-- 1. Kashier reports the flat fee itself, as `payoutFees` on the ACCOUNT
--    endpoint — it just never appears on the transaction. kashier_account now
--    stores it (plus onHoldBalance and totalOnHoldBalance, also dropped), and
--    the payouts page shows it beside the hand-entered schedule so the two can
--    be compared. Note Kashier calls it "payout" fees, which may mean per
--    transfer rather than per transaction; that is a question for Kashier, not
--    something to assume either way.
--
-- 2. The schedule is dated from the account's creation (2026-08-03) rather
--    than from when it was configured, so it covers every payment the system
--    holds. See `capture_kashier_payout_fees_and_hold_balance`.
--
-- 3. net_revenue subtracted the fee but not the 14% VAT charged on it, so it
--    came out 0.51 above net_settled on the live payment — the VAT exactly.
--    Kashier deducts fee AND VAT AND the flat fee, so all three come off, and
--    the two figures now agree at 90.84. Computing net_revenue from gross and
--    net_settled from settlementInfo keeps them an independent cross-check.
--
-- 4. The "still at Kashier" comparison read availableBalance alone, which is
--    only what can be withdrawn this minute. Money inside Kashier's settlement
--    window sits in onHoldBalance, so a payment made an hour ago was being
--    reported as a 95.84 shortfall. v_money_position now carries all three
--    balances plus collected_since_sync and hours_since_latest_payment, and
--    the panel distinguishes: stale snapshot, settlement window, genuinely
--    missing, or Kashier holding more than we ever recorded.
