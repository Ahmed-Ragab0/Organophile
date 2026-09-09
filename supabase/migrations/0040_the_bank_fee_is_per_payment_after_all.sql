-- 0040 — the fee is 5 per payment. 0038 read the evidence too far.
--
-- 0038 set `bank_fee_flat` to zero and argued it from Kashier's own balance:
--
--   totalBalanceBeforeLastTransfer   292.08
--   lastTransfer                   − 100.57
--   totalBalance                   = 191.51  =  95.84 + 95.67
--
-- Every number there is correct, and the conclusion drawn from it was not.
-- What it proves is that the balance is credited with `settled_amount`
-- untouched — that the fee is NOT taken at settlement. It says nothing about
-- what happens when Kashier moves the balance to the bank, because that side
-- appears in no API: /v2/transfers never lists an account settlement (0038),
-- and the account endpoint reports an amount with no breakdown.
--
-- A fee charged per transaction AT PAYOUT is consistent with every figure
-- observed. So is a flat fee per transfer. The balance cannot separate them,
-- and 0038 picked one and called it proven.
--
-- The account owner, who can see the bank side, says the fee is 5 per payment
-- and currently totals 15 across the three. That is the better evidence — it
-- is the only reading of the bank statement anyone has — so the schedule goes
-- back to 5 and the ledger is re-synced to match.
--
-- `effective_from` is restored to 2026-08-03 15:41:03+00 as well. It had drifted
-- to 12:41 because the editor wrote a UTC string into a datetime-local box and
-- read it back as Cairo, moving the date three hours earlier on every save
-- (fixed in web/src/components/fee-schedule.tsx). Both values sit before every
-- payment, so nothing about the money changes — but a timestamp that walks is a
-- timestamp nobody can trust later.
--
-- What is still genuinely unknown, and should not be guessed at again: whether
-- the 5 is charged per transaction or once per transfer. A settlement covering
-- several payments would answer it — bank receipt vs sum(settled) tells you
-- immediately — and until one arrives, this is the owner's figure, not a
-- derived one.

update public.kashier_fee_schedule
   set bank_fee_flat = 5.00,
       effective_from = timestamptz '2026-08-03 15:41:03+00',
       note = 'رسوم بنك ثابتة ٥ ج على كل عملية — دي قراءة صاحب الحساب من كشف '
              || 'البنك، مش رقم مستنتج. رصيد كاشير بيتقيّد بالمبلغ من غيرها '
              || '(٩٥٫٨٤ + ٩٥٫٦٧ = ١٩١٫٥١)، يعني الخصم مش وقت التسوية — '
              || 'بيحصل وقت التحويل للبنك، واللي مفيش API بيوريه. لسه مش '
              || 'متأكدين هل هي على كل عملية ولا مرة على كل تحويل: أول تحويل '
              || 'يجمّع أكتر من عملية هيحسمها.';

-- Rewrite the fee entries the zero produced. The ON CONFLICT in
-- sync_payment_to_ledger overwrites rather than coalesces, which is exactly so
-- a figure can be corrected in both directions.
do $$
declare r record;
begin
  for r in select id from public.payments where status = 'SUCCESS' loop
    perform app.sync_payment_to_ledger(r.id);
  end loop;
end $$;
