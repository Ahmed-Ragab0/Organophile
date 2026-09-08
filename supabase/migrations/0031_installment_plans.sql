-- A three-instalment enrolment reaches us as three separate purchases, months
-- apart: three ukkera transfers, three Kashier payments, three order ids.
-- Nothing in either feed says they belong together.
--
-- Each purchase stays its own subscription row — that is what the money
-- plumbing already matches on, and each one really is a distinct transaction.
-- What was missing is the thing above them: the enrolment they are instalments
-- OF. That is the plan. It owns the course price; the subscriptions under it
-- own the payments; and "still owes" is the subtraction between them.
--
-- Without this, a student who has paid the first of three instalments looks
-- fully paid, because the only figure on file was the instalment they just
-- settled.

create table if not exists public.installment_plans (
  id                uuid primary key default gen_random_uuid(),
  student_id        uuid not null references public.students(id) on delete cascade,
  course_id         uuid references public.courses(id) on delete set null,
  package_id        uuid references public.packages(id) on delete set null,
  total_due         numeric(14,2),
  installment_count int not null default 3 check (installment_count between 1 and 24),
  started_at        timestamptz not null default now(),
  closed_at         timestamptz,
  notes             text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

comment on table public.installment_plans is
  'One enrolment paid in instalments. The subscriptions pointing at it are the '
  'individual payments; this row holds what the whole course costs.';
comment on column public.installment_plans.total_due is
  'The full course price. NULL means it has not been set yet — shown as unknown '
  'rather than guessed, because a guess here becomes a debt the student does '
  'not owe.';

-- One open plan per student per course. A student who finishes a plan and
-- enrols again next year gets a second one, which is why closed_at is in the
-- predicate rather than the key.
create unique index if not exists installment_plans_open_uniq
  on public.installment_plans (student_id, course_id) where closed_at is null;
create index if not exists installment_plans_student_idx
  on public.installment_plans (student_id);

drop trigger if exists installment_plans_touch_updated_at on public.installment_plans;
create trigger installment_plans_touch_updated_at
  before update on public.installment_plans
  for each row execute function app.touch_updated_at();

alter table public.installment_plans enable row level security;
grant select, insert, update, delete on public.installment_plans to authenticated;
grant all on public.installment_plans to service_role;

drop policy if exists installment_plans_admin on public.installment_plans;
create policy installment_plans_admin on public.installment_plans
  for all to authenticated using (app.is_admin()) with check (app.is_admin());

alter table public.subscriptions
  add column if not exists plan_id   uuid references public.installment_plans(id) on delete set null,
  add column if not exists plan_kind text not null default 'other';

alter table public.subscriptions drop constraint if exists subscriptions_plan_kind_check;
alter table public.subscriptions add constraint subscriptions_plan_kind_check
  check (plan_kind in ('full', 'chapter', 'installment', 'other'));

create index if not exists subscriptions_plan_idx on public.subscriptions (plan_id);

-- ---------------------------------------------------------------------------
-- courses and packages keep their parsed structure in step with their name,
-- whatever wrote it — ukkera, an import, or a hand edit.
-- ---------------------------------------------------------------------------
create or replace function app.apply_course_name_parts()
returns trigger language plpgsql security definer set search_path = '' as $function$
declare
  a jsonb := app.parse_course_name(new.name);
begin
  new.subject          := a ->> 'subject';
  new.level            := (a ->> 'level')::int;
  new.section          := a ->> 'section';
  new.class_year       := (a ->> 'class_year')::int;
  new.track            := a ->> 'track';
  new.university_label := a ->> 'university';

  -- Resolve to a university row, but never clear one already chosen by hand:
  -- an unparseable rename must not detach a course from its university.
  if new.university_label is not null then
    new.university_id := coalesce(app.resolve_university(new.university_label),
                                  new.university_id);
  end if;
  return new;
end;
$function$;

drop trigger if exists courses_parse_name on public.courses;
create trigger courses_parse_name
  before insert or update of name on public.courses
  for each row execute function app.apply_course_name_parts();

create or replace function app.apply_package_name_parts()
returns trigger language plpgsql security definer set search_path = '' as $function$
declare
  a jsonb := app.parse_package_name(new.name);
begin
  new.kind            := coalesce(a ->> 'kind', 'other');
  new.installment_seq := (a ->> 'installment_seq')::int;
  new.chapter_name    := a ->> 'chapter';
  -- Three payments is this business's instalment plan; the column stays
  -- editable per package for the ones that differ.
  if new.kind = 'installment' and new.installment_count <= 1 then
    new.installment_count := 3;
  end if;
  return new;
end;
$function$;

drop trigger if exists packages_parse_name on public.packages;
create trigger packages_parse_name
  before insert or update of name on public.packages
  for each row execute function app.apply_package_name_parts();

-- Re-derive what is already stored.
update public.courses  set name = name;
update public.packages set name = name;

-- ---------------------------------------------------------------------------
-- ukkera now sends course_id and course_name alongside the package, and its
-- webhook fires on every real purchase rather than only on the test button.
-- This is the projection rewritten around that: it records what was bought,
-- not just that something was.
--
-- Three things happen here that did not before.
--   1. The course arrives, so its title can be taken apart into university,
--      level, section, year and track.
--   2. An instalment package opens (or joins) a plan, so the second and third
--      payments land on the same enrolment as the first.
--   3. If Kashier already wrote a row for this purchase, this adopts it instead
--      of creating a rival. Two systems, one subscription.
-- ---------------------------------------------------------------------------
alter table public.courses
  add column if not exists ukkera_course_id text;
create unique index if not exists courses_ukkera_id_uniq
  on public.courses (ukkera_course_id) where ukkera_course_id is not null;

create or replace function app.project_ukkera_event(p_raw public.ukkera_events_raw)
returns void language plpgsql security definer set search_path = '' as $function$
declare
  p             jsonb := p_raw.payload;
  v_event       text  := lower(btrim(coalesce(p ->> 'event', '')));
  v_transfer    text;
  v_name        text;
  v_phone       text;
  v_phone_n     text;
  v_email       text;
  v_course      text;
  v_course_ext  text;
  v_package     text;
  v_amount      numeric;
  v_at          timestamptz;
  v_date        date;
  v_student     uuid;
  v_course_id   uuid;
  v_package_id  uuid;
  v_pkg         public.packages;
  v_plan        uuid;
  v_sub         uuid;
  v_match_count int;
begin
  -- A connectivity check from ukkera's "test" button carries no real order
  -- (transfer_id is 0). Record it, acknowledge it, but never let it invent a
  -- student or a subscription.
  if v_event = 'test' then
    raise exception 'IGNORE: ukkera connectivity test event (no real order)';
  end if;

  v_transfer := nullif(btrim(coalesce(
                  p ->> 'transfer_id', p ->> 'order_id', p ->> 'orderId',
                  p ->> 'transaction_id', p ->> 'id', '')), '');
  if v_transfer = '0' then v_transfer := null; end if;
  if v_transfer is null then
    raise exception 'IGNORE: ukkera payload has no usable order identifier';
  end if;

  v_name       := nullif(btrim(coalesce(p ->> 'student_name', p ->> 'name', '')), '');
  v_phone      := coalesce(p ->> 'phone', p ->> 'student_phone');
  v_phone_n    := app.normalize_phone(v_phone);
  v_email      := nullif(btrim(coalesce(p ->> 'student_email', p ->> 'email', '')), '');
  v_course     := nullif(btrim(coalesce(p ->> 'course_name', p ->> 'course', '')), '');
  v_course_ext := nullif(btrim(coalesce(p ->> 'course_id', '')), '');
  if v_course_ext = '0' then v_course_ext := null; end if;
  v_package    := nullif(btrim(coalesce(p ->> 'package_name', p ->> 'package', '')), '');
  v_amount     := app.to_numeric(p ->> 'amount');

  -- The full instant, not just the day: it is the only thing that tells this
  -- purchase apart from the same student's next one when linking to Kashier.
  begin
    v_at := (coalesce(p ->> 'date', p ->> 'payment_date'))::timestamptz;
  exception when others then
    v_at := null;
  end;
  v_date := (v_at at time zone 'Africa/Cairo')::date;

  -- ------------------------------------------------------------------ course
  if v_course is not null then
    insert into public.courses (name, ukkera_course_id)
    values (v_course, v_course_ext)
    on conflict (name_key) do update
       set ukkera_course_id = coalesce(public.courses.ukkera_course_id, excluded.ukkera_course_id),
           updated_at = now()
    returning id into v_course_id;
  elsif v_course_ext is not null then
    select id into v_course_id from public.courses where ukkera_course_id = v_course_ext;
  end if;

  -- ----------------------------------------------------------------- package
  -- Lookup-then-insert rather than ON CONFLICT: the unique key is
  -- (course_id, name_key) and a NULL course_id would defeat conflict
  -- inference, silently creating a duplicate package per delivery.
  if v_package is not null then
    select id into v_package_id
      from public.packages
     where name_key = app.text_key(v_package)
       and course_id is not distinct from v_course_id
     limit 1;

    if v_package_id is null then
      insert into public.packages (course_id, name)
      values (v_course_id, v_package)
      returning id into v_package_id;
    elsif v_course_id is not null then
      update public.packages set course_id = coalesce(course_id, v_course_id)
       where id = v_package_id;
    end if;

    select * into v_pkg from public.packages where id = v_package_id;
  end if;

  -- ----------------------------------------------------------------- student
  if v_phone_n is not null then
    select id into v_student
      from public.students
     where phone_normalized = v_phone_n
     order by (app.text_key(name) = app.text_key(v_name)) desc, created_at asc
     limit 1;
  end if;

  if v_student is null and v_name is not null then
    select count(*) into v_match_count
      from public.students where app.text_key(name) = app.text_key(v_name);
    if v_match_count = 1 then
      select id into v_student
        from public.students where app.text_key(name) = app.text_key(v_name) limit 1;
    end if;
  end if;

  if v_student is null and v_name is not null then
    insert into public.students (name, phone, email)
    values (v_name, v_phone, v_email)
    returning id into v_student;
  elsif v_student is not null then
    update public.students
       set phone = coalesce(phone, v_phone),
           email = coalesce(email, v_email),
           name  = case when btrim(coalesce(name, '')) = '' then coalesce(v_name, name) else name end
     where id = v_student;
  end if;

  -- -------------------------------------------------------------------- plan
  if v_pkg.kind = 'installment' and v_student is not null then
    select id into v_plan
      from public.installment_plans
     where student_id = v_student
       and course_id is not distinct from v_course_id
       and closed_at is null
     limit 1;

    if v_plan is null then
      insert into public.installment_plans (
        student_id, course_id, package_id, total_due, installment_count
      ) values (
        v_student, v_course_id, v_package_id,
        -- The course price if it is known: set explicitly on the package, or
        -- inferred from one instalment times the count. Left NULL otherwise —
        -- an invented total becomes a debt the student does not owe.
        coalesce(v_pkg.total_price, v_pkg.price * v_pkg.installment_count),
        greatest(v_pkg.installment_count, 1)
      )
      returning id into v_plan;
    end if;
  end if;

  -- ------------------------------------------------------------ subscription
  select id into v_sub from public.subscriptions where ukkera_transfer_id = v_transfer;

  if v_sub is null then
    -- Kashier may have written this purchase already, from the payment side.
    v_sub := app.find_sibling_subscription(v_student, v_amount, v_at, 'ukkera');
  end if;

  if v_sub is not null then
    update public.subscriptions s
       set ukkera_transfer_id = v_transfer,
           ukkera_transfer_at = coalesce(v_at, s.ukkera_transfer_at),
           student_id         = coalesce(s.student_id, v_student),
           course_id          = coalesce(v_course_id, s.course_id),
           package_id         = coalesce(v_package_id, s.package_id),
           amount             = coalesce(v_amount, s.amount),
           payment_date       = coalesce(s.payment_date, v_date),
           plan_id            = coalesce(v_plan, s.plan_id),
           plan_kind          = coalesce(v_pkg.kind, s.plan_kind),
           source             = case when s.source = 'kashier_metadata'
                                     then 'ukkera_webhook' else s.source end,
           updated_at         = now()
     where s.id = v_sub;
    return;
  end if;

  insert into public.subscriptions (
    student_id, course_id, package_id, order_id, amount, payment_date, source,
    ukkera_transfer_id, ukkera_transfer_at, plan_id, plan_kind
  ) values (
    v_student, v_course_id, v_package_id, v_transfer, v_amount, v_date, 'ukkera_webhook',
    v_transfer, v_at, v_plan, coalesce(v_pkg.kind, 'other')
  )
  on conflict (order_key) do update set
    student_id         = coalesce(public.subscriptions.student_id, excluded.student_id),
    course_id          = coalesce(excluded.course_id, public.subscriptions.course_id),
    package_id         = coalesce(excluded.package_id, public.subscriptions.package_id),
    amount             = coalesce(excluded.amount, public.subscriptions.amount),
    payment_date       = coalesce(excluded.payment_date, public.subscriptions.payment_date),
    ukkera_transfer_id = coalesce(public.subscriptions.ukkera_transfer_id, excluded.ukkera_transfer_id),
    ukkera_transfer_at = coalesce(public.subscriptions.ukkera_transfer_at, excluded.ukkera_transfer_at),
    plan_id            = coalesce(public.subscriptions.plan_id, excluded.plan_id),
    plan_kind          = excluded.plan_kind,
    updated_at         = now();
end;
$function$;

-- ---------------------------------------------------------------------------
-- What a student still owes on an instalment plan lives at the plan, not at any
-- one of its payments. Each instalment subscription is settled the moment its
-- own payment lands; the debt that outlives it belongs to the enrolment.
-- ---------------------------------------------------------------------------
create or replace view public.v_installment_plans as
select
  pl.id as plan_id,
  pl.student_id,
  st.name  as student_name,
  st.phone as student_phone,
  pl.course_id,
  c.name   as course_name,
  pl.package_id,
  pk.name  as package_name,
  pl.installment_count,
  pl.total_due,
  coalesce(paid.total, 0)::numeric(14,2)  as total_paid,
  -- NULL, not zero, when the course price was never set: "not known" and
  -- "nothing left to pay" must not look the same.
  case when pl.total_due is null then null
       else greatest(pl.total_due - coalesce(paid.total, 0), 0)::numeric(14,2)
  end as remaining,
  coalesce(paid.payments_count, 0)                                  as installments_paid,
  greatest(pl.installment_count - coalesce(paid.payments_count, 0), 0) as installments_remaining,
  case
    when pl.total_due is null then null
    when greatest(pl.installment_count - coalesce(paid.payments_count, 0), 0) = 0 then null
    else round(greatest(pl.total_due - coalesce(paid.total, 0), 0)
               / greatest(pl.installment_count - coalesce(paid.payments_count, 0), 1), 2)
  end as next_installment_amount,
  paid.last_payment_at,
  pl.started_at,
  pl.closed_at,
  pl.notes,
  case
    when pl.closed_at is not null then 'closed'
    when pl.total_due is null     then 'unknown'
    when coalesce(paid.total, 0) >= pl.total_due then 'paid'
    when coalesce(paid.payments_count, 0) = 0    then 'unpaid'
    else 'partial'
  end as status
from public.installment_plans pl
left join public.students st on st.id = pl.student_id
left join public.courses  c  on c.id  = pl.course_id
left join public.packages pk on pk.id = pl.package_id
left join lateral (
  select sum(app.pnl_revenue(e.entry_type, e.amount))                as total,
         count(*) filter (where e.entry_type = 'revenue')            as payments_count,
         max(e.occurred_at) filter (where e.entry_type = 'revenue')  as last_payment_at
    from public.ledger_entries e
    join public.subscriptions s on s.id = e.subscription_id
   where s.plan_id = pl.id and e.voided_at is null and not e.is_test
) paid on true;

alter view public.v_installment_plans set (security_invoker = on);
grant select on public.v_installment_plans to authenticated, service_role;

create or replace view public.v_subscription_financials as
select s.id as subscription_id,
       s.order_id,
       s.student_id,
       s.course_id,
       s.package_id,
       s.created_at as enrolled_at,
       s.due_date,
       s.installment_count,
       coalesce(s.total_due, pk.price, s.amount, 0)::numeric(14,2) as total_due,
       coalesce(paid.total, 0)::numeric(14,2) as total_paid,
       greatest(coalesce(s.total_due, pk.price, s.amount, 0)
                - coalesce(paid.total, 0), 0)::numeric(14,2) as remaining,
       paid.last_payment_at,
       paid.payments_count,
       case
         when coalesce(s.total_due, pk.price, s.amount, 0) <= 0 then
           case when coalesce(paid.total, 0) > 0 then 'paid' else 'unknown' end
         when coalesce(paid.total, 0) >= coalesce(s.total_due, pk.price, s.amount, 0) then 'paid'
         when s.due_date is not null and s.due_date < current_date then 'overdue'
         when coalesce(paid.total, 0) > 0 then 'partial'
         else 'unpaid'
       end as payment_status,
       s.plan_id,
       s.plan_kind,
       s.ukkera_transfer_id,
       s.merchant_order_key
  from public.subscriptions s
  left join public.packages pk on pk.id = s.package_id
  left join lateral (
    select sum(app.pnl_revenue(e.entry_type, e.amount))               as total,
           max(e.occurred_at) filter (where e.entry_type = 'revenue') as last_payment_at,
           count(*) filter (where e.entry_type = 'revenue')           as payments_count
      from public.ledger_entries e
     where e.subscription_id = s.id and e.voided_at is null and not e.is_test
  ) paid on true;
alter view public.v_subscription_financials set (security_invoker = on);

-- Outstanding, counted once. A plan-attached subscription is settled by its own
-- instalment; what remains is held by the plan. Adding both together would
-- count an unpaid first instalment twice — once as the purchase and once as
-- the enrolment.
create or replace view public.v_outstanding as
select coalesce((select sum(f.remaining) from public.v_subscription_financials f
                  where f.plan_id is null), 0)
     + coalesce((select sum(p.remaining) from public.v_installment_plans p
                  where p.closed_at is null), 0) as outstanding_amount;
alter view public.v_outstanding set (security_invoker = on);
grant select on public.v_outstanding to authenticated, service_role;

create or replace view public.v_student_financials as
select st.id as student_id,
       st.name, st.phone, st.phone_normalized, st.email, st.group_name,
       st.is_active, st.created_at as registered_at,
       st.university_id, u.name as university_name,
       coalesce(f.subscriptions_count, 0) as subscriptions_count,
       (coalesce(f.total_due, 0) + coalesce(pl.total_due, 0))::numeric(14,2) as total_due,
       (coalesce(f.total_paid, 0))::numeric(14,2)                            as total_paid,
       (coalesce(f.remaining, 0) + coalesce(pl.remaining, 0))::numeric(14,2) as remaining,
       greatest(f.last_payment_at, pl.last_payment_at) as last_payment_at,
       f.courses,
       case
         when coalesce(f.subscriptions_count, 0) = 0 then 'unknown'
         when coalesce(f.overdue_count, 0) > 0 then 'overdue'
         when coalesce(f.remaining, 0) + coalesce(pl.remaining, 0) <= 0
              and coalesce(f.total_due, 0) + coalesce(pl.total_due, 0) > 0 then 'paid'
         when coalesce(f.total_paid, 0) > 0 then 'partial'
         else 'unpaid'
       end as payment_status,
       coalesce(pl.plans_count, 0)   as installment_plans,
       coalesce(pl.remaining, 0)::numeric(14,2) as installment_remaining
  from public.students st
  left join public.universities u on u.id = st.university_id
  left join lateral (
    -- Plan-attached subscriptions are excluded here and counted once through
    -- the plan below.
    select count(*) as subscriptions_count,
           sum(sf.total_due) filter (where sf.plan_id is null)  as total_due,
           sum(sf.total_paid)                                   as total_paid,
           sum(sf.remaining) filter (where sf.plan_id is null)  as remaining,
           max(sf.last_payment_at)                              as last_payment_at,
           count(*) filter (where sf.payment_status = 'overdue') as overdue_count,
           string_agg(distinct c.name, ' · ')                   as courses
      from public.v_subscription_financials sf
      left join public.courses c on c.id = sf.course_id
     where sf.student_id = st.id
  ) f on true
  left join lateral (
    select count(*) as plans_count,
           sum(p.total_due) as total_due,
           sum(p.remaining) as remaining,
           max(p.last_payment_at) as last_payment_at
      from public.v_installment_plans p
     where p.student_id = st.id and p.closed_at is null
  ) pl on true;
alter view public.v_student_financials set (security_invoker = on);

create or replace view public.v_subscriptions_list as
select s.id as subscription_id,
       s.order_id,
       s.source,
       s.created_at as enrolled_at,
       s.payment_date,
       s.due_date,
       s.installment_count,
       s.amount as order_amount,
       s.total_due as price_override,
       st.id as student_id, st.name as student_name, st.phone as student_phone,
       st.phone_normalized as student_phone_normalized,
       c.id as course_id, c.name as course_name,
       pk.id as package_id, pk.name as package_name, pk.price as package_price,
       coalesce(f.total_due, 0) as total_due,
       coalesce(f.total_paid, 0) as total_paid,
       coalesce(f.remaining, 0) as remaining,
       f.payment_status,
       coalesce(f.payments_count, 0) as payments_count,
       f.last_payment_at,
       case when s.total_due is not null then 'override'
            when pk.price is not null then 'package'
            when s.amount is not null then 'order'
            else 'none' end as price_source,
       s.plan_kind,
       s.plan_id,
       s.ukkera_transfer_id,
       s.merchant_order_key,
       pl.total_due  as plan_total_due,
       pl.total_paid as plan_total_paid,
       pl.remaining  as plan_remaining,
       pl.installments_paid,
       pl.installment_count as plan_installment_count,
       pl.next_installment_amount,
       pl.status as plan_status,
       -- The course's own facts, so the list can be filtered by them without a
       -- second query.
       c.university_id, c.university_label, c.level, c.section, c.class_year, c.track,
       pk.kind as package_kind, pk.installment_seq, pk.chapter_name
  from public.subscriptions s
  left join public.students st on st.id = s.student_id
  left join public.courses c on c.id = s.course_id
  left join public.packages pk on pk.id = s.package_id
  left join public.v_subscription_financials f on f.subscription_id = s.id
  left join public.v_installment_plans pl on pl.plan_id = s.plan_id;
alter view public.v_subscriptions_list set (security_invoker = on);

-- ---------------------------------------------------------------------------
-- Rebuilt rather than replaced, because the old shape carried the confusion in
-- its column names: total_revenue and net_revenue were two names for two
-- different numbers, total_expenses silently included the gateway's cut, and
-- other_expenses existed only to subtract it back out again with a GREATEST()
-- guarding against the arithmetic going negative.
--
-- Everything is read from the ledger, including the fees. Mixing sources —
-- revenue from the ledger, fees from `payments` — is how a "discrepancy" gets
-- invented out of two things that were never the same measurement.
-- v_money_position remains the independent check against Kashier's own numbers.
-- ---------------------------------------------------------------------------
drop view if exists public.v_dashboard_kpis;

create view public.v_dashboard_kpis as
with book as (
  select
    coalesce(sum(app.pnl_revenue(entry_type, amount)), 0) as gross,
    coalesce(sum(app.pnl_fee(entry_type, amount)), 0)     as fees,
    coalesce(sum(app.pnl_expense(entry_type, amount)), 0) as expenses,
    coalesce(sum(app.pnl_revenue(entry_type, amount)) filter (where in_month), 0) as m_gross,
    coalesce(sum(app.pnl_fee(entry_type, amount))     filter (where in_month), 0) as m_fees,
    coalesce(sum(app.pnl_expense(entry_type, amount)) filter (where in_month), 0) as m_expenses
  from (
    select entry_type, amount,
           (occurred_at at time zone 'Africa/Cairo')
             >= date_trunc('month', now() at time zone 'Africa/Cairo') as in_month
      from public.ledger_entries
     where voided_at is null and not is_test
  ) e
)
select
  date_trunc('month', now() at time zone 'Africa/Cairo')::date as current_month,
  b.gross                          as student_payments,
  b.fees                           as gateway_fees,
  b.gross - b.fees                 as net_revenue,
  b.expenses                       as expenses,
  b.gross - b.fees - b.expenses    as net_profit,
  b.m_gross                        as month_student_payments,
  b.m_fees                         as month_gateway_fees,
  b.m_gross - b.m_fees             as month_net_revenue,
  b.m_expenses                     as month_expenses,
  b.m_gross - b.m_fees - b.m_expenses as month_net_profit,
  (select outstanding_amount from public.v_outstanding)           as outstanding_amount,
  (select count(*) filter (where is_active) from public.students) as students_active,
  (select count(*) from public.students)                          as students_total,
  (select count(*) from public.subscriptions)                     as subscriptions_total,
  (select coalesce(sum(wb.balance), 0) from public.v_wallet_balances wb
     join public.wallets w on w.id = wb.id
    where wb.is_active and not w.is_kashier_default)              as in_own_wallets,
  (select coalesce(sum(wb.balance), 0) from public.v_wallet_balances wb
     join public.wallets w on w.id = wb.id
    where wb.is_active and w.is_kashier_default)                  as at_kashier_wallet,
  (select coalesce(sum(coalesce(amount, 0)), 0) from public.payouts
    where mode = 'live' and event = 'TRANSFERRED')                as payouts_received,
  (select coalesce(sum(coalesce(amount, 0)), 0) from public.payouts
    where mode = 'live'
      and event in ('INITIATED', 'IN_TRANSIT', 'PARTIALLY_TRANSFERRED')) as payouts_in_flight,
  (select count(*) from public.v_unmatched_payments where mode = 'live') as unmatched_payments,
  (select count(*) from public.v_unpaid_subscriptions)                   as unpaid_subscriptions,
  (select count(*) from public.kashier_events_raw
    where state = 'failed'::app.ingest_state)                            as failed_ingest_events,
  (select count(*) from public.v_installment_plans
    where closed_at is null and status in ('partial', 'unpaid'))         as open_installment_plans
from book b;
alter view public.v_dashboard_kpis set (security_invoker = on);
grant select on public.v_dashboard_kpis to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- repair what the split keys already produced (0029)
--
-- Runs here, after the projection above exists: replaying the deliveries
-- against the old projection would simply recreate the duplicates.
-- ---------------------------------------------------------------------------
update public.subscriptions s
   set merchant_order_key = s.order_key
 where s.merchant_order_key is null
   and exists (select 1 from public.payments p where p.merchant_order_key = s.order_key);

-- The rival rows ukkera wrote for purchases Kashier had already recorded. They
-- carry no ledger entries and no overrides — the ledger attached to the
-- Kashier-side row — and the replay below rebuilds every one of them, this time
-- adopting instead of duplicating.
delete from public.subscriptions
 where source = 'ukkera_webhook' and merchant_order_key is null;

do $$
declare r public.ukkera_events_raw;
begin
  for r in select * from public.ukkera_events_raw
            where state = 'processed' order by received_at loop
    begin
      perform app.project_ukkera_event(r);
    exception when others then
      raise notice 'ukkera % : %', r.id, sqlerrm;
    end;
  end loop;
end $$;

do $$
declare v uuid;
begin
  for v in select id from public.payments order by transaction_date loop
    perform app.derive_order_from_payment(v);
    perform app.sync_payment_to_ledger(v);
  end loop;
end $$;
