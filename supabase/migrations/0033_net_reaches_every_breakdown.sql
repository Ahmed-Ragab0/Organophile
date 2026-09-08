-- The three views the earlier passes did not reach, each for the same reason:
-- they reported a gross figure under a name that now means net.

-- --------------------------------------------------------------------------
-- The course catalogue is where "which university, which track" gets answered,
-- so it has to carry the facts the title was taken apart into. Without them the
-- parsing exists only in the database and the screen that needs it still shows
-- one long string.
--
-- Money here is plan-aware for the same reason it is everywhere else: a course
-- sold in instalments has debt that lives on the plan, and a catalogue that
-- summed only the subscriptions would report it as fully collected.
-- --------------------------------------------------------------------------
create or replace view public.v_course_catalogue as
select c.id as course_id,
       c.name as course_name,
       c.is_active,
       u.id as university_id,
       coalesce(u.name, 'غير محدد') as university_name,
       coalesce(sub.subscriptions_count, 0) as students_count,
       (coalesce(sub.total_due, 0) + coalesce(pl.total_due, 0))::numeric(14,2) as total_due,
       (coalesce(sub.total_paid, 0))::numeric(14,2)                            as total_paid,
       (coalesce(sub.remaining, 0) + coalesce(pl.remaining, 0))::numeric(14,2) as remaining,
       c.subject,
       c.level,
       c.section,
       c.class_year,
       c.track,
       c.university_label,
       -- Distinct people, not distinct purchases: a student who buys three
       -- instalments is one student on this course.
       coalesce(sub.students_count, 0) as enrolled_students,
       coalesce(pl.plans_count, 0)     as installment_plans
  from public.courses c
  left join public.universities u on u.id = c.university_id
  left join lateral (
    select count(*) as subscriptions_count,
           count(distinct sf.student_id) as students_count,
           sum(sf.total_due)  filter (where sf.plan_id is null) as total_due,
           sum(sf.total_paid)                                   as total_paid,
           sum(sf.remaining)  filter (where sf.plan_id is null) as remaining
      from public.v_subscription_financials sf
     where sf.course_id = c.id
  ) sub on true
  left join lateral (
    select count(*) as plans_count,
           sum(p.total_due) as total_due,
           sum(p.remaining) as remaining
      from public.v_installment_plans p
     where p.course_id = c.id and p.closed_at is null
  ) pl on true;
alter view public.v_course_catalogue set (security_invoker = on);

-- --------------------------------------------------------------------------
-- Kashier's settlementInfo reports what IT settles, which is before the flat
-- bank fee it never mentions. `net_after_bank_fee` already corrected for that;
-- this names the whole deduction so the payments list can show the same
-- subtraction the ledger does.
-- --------------------------------------------------------------------------
create or replace view public.v_payments_enriched as
select p.id, p.transaction_id, p.kashier_order_id, p.merchant_order_id,
       p.order_reference, p.event, p.status, p.mode, p.amount, p.currency,
       p.settled_amount, p.fees, p.vat,
       app.signed_amount(p.event, p.status, p.amount) as signed_amount,
       p.method, p.channel, p.card_brand, p.masked_card, p.apikey_name,
       p.transaction_date, p.response_code, p.response_message,
       p.is_test_webhook, p.created_at, p.updated_at,
       m.subscription_id, m.match_method,
       sub.order_id as subscription_order_id,
       sub.payment_date as subscription_payment_date,
       st.id as student_id, st.name as student_name, st.phone as student_phone,
       st.group_name as student_group, st.university as student_university,
       c.id as course_id, c.name as course_name,
       pk.id as package_id, pk.name as package_name,
       p.ukkera_transfer_id, p.payer_name, p.payer_phone, p.payer_email,
       case when p.status = 'SUCCESS' and p.event in ('pay', 'capture')
            then app.bank_fee_at(p.mode, p.transaction_date)
            else 0 end as bank_fee,
       case when p.status = 'SUCCESS' and p.event in ('pay', 'capture')
            then coalesce(p.settled_amount, p.amount, 0)
               - app.bank_fee_at(p.mode, p.transaction_date)
            else coalesce(p.settled_amount, p.amount, 0) end as net_after_bank_fee,
       case when p.status = 'SUCCESS' and p.event in ('pay', 'capture')
            then coalesce(p.fees, 0) + coalesce(p.vat, 0)
               + app.bank_fee_at(p.mode, p.transaction_date)
            else 0 end as fees_total,
       sub.ukkera_transfer_id as subscription_transfer_id,
       sub.plan_id,
       sub.plan_kind
  from public.payments p
  join public.v_payment_matches m on m.payment_id = p.id
  left join public.subscriptions sub on sub.id = m.subscription_id
  left join public.students st on st.id = sub.student_id
  left join public.courses c on c.id = sub.course_id
  left join public.packages pk on pk.id = sub.package_id;
alter view public.v_payments_enriched set (security_invoker = on);

-- --------------------------------------------------------------------------
-- `revenue` here was the gross charge and `fees` omitted both the VAT on the
-- commission and the flat bank fee, so `settled` — Kashier's own figure — was
-- the only column close to what arrives, and it was still 5 EGP short.
--
-- Renaming revenue to net everywhere else made this actively misleading: the
-- same header meant two different things on two tabs of one page. The gross
-- keeps its own name, the fee is the whole fee, and the net is the net. The
-- old columns stay for compatibility and are marked deprecated in the types.
-- --------------------------------------------------------------------------
create or replace view public.v_revenue_by_method as
select date_trunc('month', (transaction_date at time zone 'Africa/Cairo'))::date as month,
       coalesce(nullif(btrim(method), ''), 'غير محدد') as method,
       count(*) filter (where event in ('pay', 'capture')) as payments,
       coalesce(sum(amount) filter (where event in ('pay', 'capture')), 0) as revenue,
       coalesce(sum(coalesce(fees, 0)) filter (where event in ('pay', 'capture')), 0) as fees,
       coalesce(sum(coalesce(settled_amount, amount, 0))
                filter (where event in ('pay', 'capture')), 0) as settled,
       coalesce(sum(amount) filter (where event in ('pay', 'capture')), 0)
         as student_payments,
       coalesce(sum(coalesce(fees, 0) + coalesce(vat, 0)
                    + app.bank_fee_at(mode, transaction_date))
                filter (where event in ('pay', 'capture')), 0) as fees_total,
       coalesce(sum(coalesce(amount, 0)
                    - (coalesce(fees, 0) + coalesce(vat, 0)
                       + app.bank_fee_at(mode, transaction_date)))
                filter (where event in ('pay', 'capture')), 0) as net_received
  from public.payments p
 where status = 'SUCCESS' and not is_test_webhook and mode = 'live'
   and transaction_date is not null
 group by 1, 2;
alter view public.v_revenue_by_method set (security_invoker = on);
