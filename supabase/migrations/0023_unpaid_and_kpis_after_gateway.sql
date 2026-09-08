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
