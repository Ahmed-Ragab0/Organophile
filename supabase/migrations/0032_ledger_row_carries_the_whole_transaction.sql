-- One payment writes two ledger entries — the student's payment and the fee
-- withheld from it — and the ledger showed them as two rows. Correct as
-- bookkeeping, unreadable as a record of a purchase: the row saying 100 and
-- the row saying 9.33 sit apart, and neither says what actually arrived.
--
-- The entries stay as they are; the view now carries the whole transaction on
-- each of them, so a single row can state charged / withheld / received, and a
-- detail panel can show the breakdown without a second query.
--
-- Late in the series because it reads subscriptions.ukkera_transfer_id and the
-- package a subscription points at, neither of which exists before 0031.
create or replace view public.v_ledger as
select e.id, e.entry_type, e.amount, e.occurred_at, e.description, e.category,
       e.reference, e.metadata, e.is_test, e.transfer_group_id, e.voided_at,
       e.void_reason, e.created_at,
       app.wallet_delta(e.entry_type, e.amount) as wallet_delta,
       app.pnl_revenue(e.entry_type, e.amount)  as revenue_effect,
       app.pnl_expense(e.entry_type, e.amount)  as expense_effect,
       e.wallet_id, w.name as wallet_name, w.type as wallet_type,
       e.student_id, st.name as student_name, st.phone as student_phone,
       e.course_id, c.name as course_name,
       e.subscription_id, sub.order_id as subscription_order_id,
       e.payment_id, p.transaction_id as kashier_transaction_id,
       p.method as payment_method, p.status as payment_status,
       app.pnl_fee(e.entry_type, e.amount) as fee_effect,
       -- Read off the payment, not off the entry's own metadata: a fee
       -- schedule correction must reach a row already written.
       case when p.event in ('pay', 'capture')
            then abs(coalesce(p.amount, 0)) end as payment_gross,
       case when p.event in ('pay', 'capture')
            then coalesce(p.fees, 0) + coalesce(p.vat, 0)
               + app.bank_fee_at(p.mode, p.transaction_date) end as payment_fees,
       case when p.event in ('pay', 'capture')
            then abs(coalesce(p.amount, 0))
               - (coalesce(p.fees, 0) + coalesce(p.vat, 0)
                  + app.bank_fee_at(p.mode, p.transaction_date)) end as payment_net,
       -- The fee, itemised. "9.33" invites the question; these three answer it.
       p.fees                                        as payment_fee_gateway,
       p.vat                                         as payment_fee_vat,
       case when p.id is not null
            then app.bank_fee_at(p.mode, p.transaction_date) end as payment_fee_bank,
       p.settled_amount                              as payment_settled_amount,
       p.merchant_order_id                           as payment_merchant_order_id,
       p.ukkera_transfer_id                          as payment_link_id,
       p.card_brand                                  as payment_card_brand,
       p.masked_card                                 as payment_masked_card,
       p.channel                                     as payment_channel,
       p.transaction_date                            as payment_date,
       p.mode                                        as payment_mode,
       sub.ukkera_transfer_id                        as subscription_transfer_id,
       pk.name                                       as package_name,
       u.name                                        as university_name
  from public.ledger_entries e
  join public.wallets w on w.id = e.wallet_id
  left join public.students st on st.id = e.student_id
  left join public.courses c on c.id = e.course_id
  left join public.universities u on u.id = c.university_id
  left join public.subscriptions sub on sub.id = e.subscription_id
  left join public.packages pk on pk.id = sub.package_id
  left join public.payments p on p.id = e.payment_id;

alter view public.v_ledger set (security_invoker = on);
