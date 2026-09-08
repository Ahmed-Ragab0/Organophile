-- 0023_unpaid_and_kpis_after_gateway.sql
--
-- Two things the first real payment surfaced once it was on screen.
--
-- 1. The overview said "1 unpaid subscription" for an order that was matched,
--    attributed in the ledger, and shown as paid on the journey page. The
--    dashboard was contradicting itself, because v_unpaid_subscriptions asks
--    its own question and was still asking it with merchant_order_key — the
--    key 0020 disproved. reconcile_transactions had the same problem.
--
--    Worth noting how it was missed: 0020 fixed every place that *matches* a
--    payment to an order, but this view *counts* the ones that do not, and a
--    grep for the matching logic did not surface it. The check that would have
--    caught it is the one used here — find every remaining reference to
--    merchant_order_key in pg_proc and pg_views, not just the ones you
--    remember writing.
--
-- 2. The overview reported revenue and net profit straight from the ledger,
--    which records the gross amount a student was charged. Nothing on the page
--    said what survived the gateway, so the headline read 100.00 on a payment
--    that delivers 90.84.

create or replace view public.v_unpaid_subscriptions
with (security_invoker = on) as
 SELECT s.id,
    s.order_id,
    s.amount,
    s.payment_date,
    s.created_at,
    st.name AS student_name,
    st.phone AS student_phone,
    c.name AS course_name
   FROM public.subscriptions s
     LEFT JOIN public.students st ON st.id = s.student_id
     LEFT JOIN public.courses c ON c.id = s.course_id
  WHERE NOT (EXISTS ( SELECT 1
           FROM public.payments p
          WHERE (p.ukkera_transfer_key = s.order_key
                 OR p.merchant_order_key = s.order_key)
            AND p.status = 'SUCCESS'::public.txn_status
            AND (p.event = ANY (ARRAY['pay'::public.kashier_txn_event, 'capture'::public.kashier_txn_event]))))
    -- A manual link is a human saying this payment belongs to this order, so
    -- it counts here too. Without this clause, reconciling a payment by hand
    -- left its order in the unpaid list forever.
    AND NOT (EXISTS ( SELECT 1
           FROM public.payment_subscription_overrides o
             JOIN public.payments p2 ON p2.id = o.payment_id
          WHERE o.subscription_id = s.id
            AND p2.status = 'SUCCESS'::public.txn_status
            AND (p2.event = ANY (ARRAY['pay'::public.kashier_txn_event, 'capture'::public.kashier_txn_event]))));

comment on view public.v_unpaid_subscriptions is
  'Orders with no successful Kashier payment against them, matched on ukkera''s transfer_id, the legacy merchantOrderId, or a manual override.';

-- reconcile_transactions: the same one-line change, in its payment lookup.
--   where (p.ukkera_transfer_key = v_order or p.merchant_order_key = v_order)
-- See migration `unpaid_and_reconcile_use_ukkera_transfer_key` for the body.

-- v_dashboard_kpis gains, appended so existing column order is untouched:
--   gateway_fees, month_gateway_fees   Kashier fee + VAT + flat bank fee
--   net_revenue, month_net_revenue     ledger revenue minus those
--   net_after_everything               also minus recorded expenses
--
-- Kept as separate columns rather than folded into net_profit: revenue and
-- expenses come from the ledger, gateway fees come from the payment feed, and
-- mixing two sources into one figure makes it impossible to say which moved
-- when it changes. See `dashboard_kpis_carry_net_after_gateway`.

-- ---------------------------------------------------------------------------
-- Follow-up: the balance comparison had the wrong account AND the wrong basis
-- ---------------------------------------------------------------------------
--
-- With the deliberate account selection deployed, /v2/account turned out to
-- return TWO accounts for this merchant:
--
--   ACC-48090-321-02  isPrimary false  total 0       lastTransfer 0
--   ACC-48090-321-01  isPrimary true   total 100.57  lastTransfer 95.67
--
-- Every balance read until now came from the empty one, purely because it was
-- first in the array. That is the whole reason Kashier appeared to hold
-- nothing while real money had been collected.
--
-- The primary account then changed what the comparison has to be made
-- against. It reports totalBalance 100.57 with availableBalance 0 and
-- onHoldBalance 0 — the three do not sum, so Kashier keeps a bucket it does
-- not break out, and `available` is only what is withdrawable this minute.
--
-- totalBalance is also GROSS: 100.57 against our 100.00 collected, while our
-- net after fees is 90.84. Kashier takes its fee at settlement rather than at
-- collection. So v_money_position now compares gross against gross via
-- awaiting_payout_gross; comparing our net against their gross would report a
-- permanent shortfall the size of the fees. The remaining difference is 0.57,
-- a residue of the 95.67 already transferred out.

-- ---------------------------------------------------------------------------
-- Follow-up: what the 0.57 difference actually is
-- ---------------------------------------------------------------------------
--
-- The primary account's full payload explains it:
--
--   lastTransfer                    95.67
--   lastTransferDate                2026-09-01T05:17:42Z
--   lastTransferReference           BT-1788239911170-987
--   totalBalanceBeforeLastTransfer  95.67
--   totalBalance                    100.57
--
-- The balance before that transfer was exactly the amount transferred, so
-- Kashier emptied the account to zero on 1 September. Our first recorded
-- payment is 8 September, 100.00 gross. Everything since the account was
-- zeroed is therefore our 100.00 plus 0.57 that arrived at Kashier without
-- reaching this system.
--
-- 0.57 on a 100 EGP balance is a rounding residue, not a missing transaction,
-- and the flat 0.5 threshold was calling it one. The panel now scales the
-- threshold to the money involved (1%, floor 2 EGP) and names a real but
-- immaterial difference as small rather than either hiding it or raising it as
-- an alarm.
--
-- v_money_position also now exposes kashier_last_transfer / _at / _ref and
-- our_records_start. Our `transferred` reads 0 because that payout predates
-- the system entirely, and showing only our figure next to Kashier's balance
-- reads as a contradiction rather than as two records that begin on different
-- dates.
