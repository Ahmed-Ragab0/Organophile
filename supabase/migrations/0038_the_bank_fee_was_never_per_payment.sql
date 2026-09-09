-- 0038 — the 5 EGP was never a per-payment fee.
--
-- 0022 introduced `kashier_fee_schedule` with a 5.00 flat "bank fee per
-- transaction", reasoning from the one number Kashier exposes: `payoutFees: 5`
-- on the account endpoint. The name should have been the warning. It is a
-- property of the PAYOUT METHOD, charged once per transfer to the bank — not
-- once per payment taken.
--
-- 0022 even recorded the evidence against itself: "the payment on 8 Sep 2026
-- settled at 95.84 (100 − 3.65 fee − 0.51 VAT) with NO bank fee. A hardcoded 5
-- would silently restate it as 90.84." It then hardcoded 5 anyway, and every
-- later pass propagated it — the order journey, the payout attribution, the
-- money position — each one made consistent with a premise that was wrong.
--
-- Kashier's own account balance settles it, to the piastre:
--
--   totalBalanceBeforeLastTransfer   292.08
--   lastTransfer                   − 100.57   (9 Sep 2026, 08:12 Cairo)
--   totalBalance                   = 191.51   ← what the API reports now
--
--   settled_amount of payment #1      95.84
--   settled_amount of payment #2    + 95.67
--                                   = 191.51   ← the same number
--
-- Kashier credits `settled_amount` to the balance untouched. Had 5 been taken
-- per payment the balance would read 181.51. It reads 191.51. And the transfer
-- removed exactly its own amount from the balance — 292.08 − 100.57 = 191.51 —
-- so no fee was withheld from the balance on the way out either. The fee is
-- applied to the transfer, once, and reduces what the bank receives.
--
-- So the schedule row is corrected in place rather than superseded by a new
-- effective-dated one. Effective dating exists so a fee that CHANGES does not
-- restate a reconciled month; this fee never existed, and dating the correction
-- from today would leave three payments permanently 5 EGP short each.
--
-- The mechanism stays: the day Kashier does start charging per transaction, a
-- new row with a real effective_from is the way to record it.
--
-- What the transfer fee costs is not lost — `kashier_account.payout_fees`
-- carries it, straight from the gateway. It belongs on a payout, and payouts
-- are not being ingested at all yet: `kashier_events_raw` holds three `pay`
-- events and zero `transfer` events, and `public.payouts` is empty, which is
-- why nothing in the system can say whether the 100.57 reached the bank.

update public.kashier_fee_schedule
   set bank_fee_flat = 0,
       note = 'صفر عن قصد. الـ ٥ جنيه دي رسوم تحويل للبنك (payoutFees) '
              || 'بتتاخد مرة واحدة على كل تحويل، مش على كل عملية — رصيد كاشير '
              || 'نفسه أثبت كده: ٩٥٫٨٤ + ٩٥٫٦٧ = ١٩١٫٥١ من غير أي خصم. '
              || 'الجدول ده لسه هو المكان الصح لو كاشير بدأت تخصم على العملية.',
       updated_at = now()
 where bank_fee_flat <> 0;

-- Rewrite the fee entries the old premise produced. sync_payment_to_ledger
-- reads app.bank_fee_at, and its ON CONFLICT overwrites rather than coalesces
-- precisely so a wrong figure stays correctable.
do $$
declare r record;
begin
  for r in select id from public.payments where status = 'SUCCESS' loop
    perform app.sync_payment_to_ledger(r.id);
  end loop;
end $$;
