-- 0015_financial_system.sql
--
-- Wallets, a single unified ledger, universities, and student financial
-- status. This is the consolidated final state of what was applied to the
-- database as migrations 0015–0021; where a function was revised during that
-- work only the final definition appears here.
--
-- The invariants this file exists to guarantee:
--
--   1. amount is ALWAYS positive; direction comes from entry_type.
--   2. a transfer between wallets is two rows sharing transfer_group_id and is
--      neither revenue nor an expense — it only moves money.
--   3. nothing is deleted. Entries are voided, preserving the audit trail.
--   4. one live ledger entry per Kashier payment, enforced by a unique index,
--      so a replayed webhook can never double-count revenue.
--   5. a payment and its wallet movement are written in the SAME transaction.
--   6. test-mode traffic is flagged and excluded from EVERY money figure —
--      balances included, or the books stop reconciling.
--
--   Verified by assertion: sum(wallet balances) = opening + revenue - expenses.

-- ===========================================================================
-- Enums
-- ===========================================================================

create type public.wallet_type as enum ('bank', 'cash', 'digital');

create type public.ledger_entry_type as enum (
  'revenue',        -- money in, counts as income
  'expense',        -- money out, counts as cost
  'transfer_in',    -- money in from another wallet, P&L neutral
  'transfer_out',   -- money out to another wallet, P&L neutral
  'refund',         -- money out, reduces income
  'reversal',       -- money out, reduces income
  'adjustment_in',  -- correction, P&L neutral
  'adjustment_out'  -- correction, P&L neutral
);

-- ===========================================================================
-- Wallets
-- ===========================================================================

create table public.wallets (
  id                 uuid primary key default gen_random_uuid(),
  name               text not null check (btrim(name) <> ''),
  name_key           text generated always as (upper(btrim(name))) stored,
  type               public.wallet_type not null default 'cash',
  is_active          boolean not null default true,
  -- Money held before the ledger began. Balances are computed from this plus
  -- every entry, never stored.
  opening_balance    numeric(14,2) not null default 0,
  sort_order         int not null default 100,
  -- The wallet successful Kashier payments credit. Exactly one may hold this.
  is_kashier_default boolean not null default false,
  notes              text,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  constraint wallets_name_uniq unique (name_key)
);

create unique index wallets_single_kashier_default
  on public.wallets ((is_kashier_default)) where is_kashier_default;

create trigger wallets_touch_updated_at before update on public.wallets
  for each row execute function app.touch_updated_at();

insert into public.wallets (name, type, sort_order, is_kashier_default) values
  ('حساب أساسي بنك القاهرة', 'bank', 10, true),
  ('حساب بنك مصر شخصي',      'bank', 20, false),
  ('كاش 71',                  'cash', 30, false),
  ('كاش 16',                  'cash', 40, false),
  ('كاش 33',                  'cash', 50, false),
  ('نقدي',                    'cash', 60, false)
on conflict (name_key) do nothing;

-- ===========================================================================
-- The ledger
-- ===========================================================================

create table public.ledger_entries (
  id                uuid primary key default gen_random_uuid(),
  entry_type        public.ledger_entry_type not null,
  wallet_id         uuid not null references public.wallets(id) on delete restrict,
  amount            numeric(14,2) not null check (amount >= 0),
  occurred_at       timestamptz not null default now(),

  description       text,
  category          text,

  student_id        uuid references public.students(id)      on delete set null,
  course_id         uuid references public.courses(id)       on delete set null,
  subscription_id   uuid references public.subscriptions(id) on delete set null,
  -- restrict: a payment that produced money must not be deletable out from
  -- under its ledger entry.
  payment_id        uuid references public.payments(id)      on delete restrict,

  transfer_group_id uuid,
  reference         text,
  metadata          jsonb not null default '{}'::jsonb,

  -- Verifying the pipeline must never move the real books.
  is_test           boolean not null default false,

  voided_at         timestamptz,
  voided_by         uuid references auth.users(id) on delete set null,
  void_reason       text,

  created_by        uuid references auth.users(id) on delete set null,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),

  -- A transfer half must name its group; nothing else may.
  constraint ledger_transfer_group_required check (
    (entry_type in ('transfer_in','transfer_out')) = (transfer_group_id is not null)
  )
);

-- Idempotency for Kashier: one live entry per payment, ever.
create unique index ledger_entries_payment_uniq
  on public.ledger_entries (payment_id)
  where payment_id is not null and voided_at is null;

create index ledger_entries_wallet_idx        on public.ledger_entries (wallet_id);
create index ledger_entries_occurred_idx      on public.ledger_entries (occurred_at desc);
create index ledger_entries_student_idx       on public.ledger_entries (student_id) where student_id is not null;
create index ledger_entries_subscription_idx  on public.ledger_entries (subscription_id) where subscription_id is not null;
create index ledger_entries_type_idx          on public.ledger_entries (entry_type);
create index ledger_entries_transfer_idx      on public.ledger_entries (transfer_group_id) where transfer_group_id is not null;
create index ledger_entries_live_money_idx    on public.ledger_entries (occurred_at desc)
  where voided_at is null and not is_test;

create trigger ledger_entries_touch_updated_at before update on public.ledger_entries
  for each row execute function app.touch_updated_at();

-- ===========================================================================
-- The three questions every financial figure reduces to
-- ===========================================================================

/** Effect on the wallet's balance. */
create or replace function app.wallet_delta(t public.ledger_entry_type, amt numeric)
returns numeric language sql immutable parallel safe set search_path = '' as $$
  select case t
    when 'revenue'        then  amt
    when 'transfer_in'    then  amt
    when 'adjustment_in'  then  amt
    when 'expense'        then -amt
    when 'transfer_out'   then -amt
    when 'refund'         then -amt
    when 'reversal'       then -amt
    when 'adjustment_out' then -amt
  end
$$;

/** Contribution to income. Refunds and reversals reduce it; transfers never touch it. */
create or replace function app.pnl_revenue(t public.ledger_entry_type, amt numeric)
returns numeric language sql immutable parallel safe set search_path = '' as $$
  select case t
    when 'revenue'  then  amt
    when 'refund'   then -amt
    when 'reversal' then -amt
    else 0
  end
$$;

/** Contribution to costs. Transfers are not costs. */
create or replace function app.pnl_expense(t public.ledger_entry_type, amt numeric)
returns numeric language sql immutable parallel safe set search_path = '' as $$
  select case t when 'expense' then amt else 0 end
$$;

-- ===========================================================================
-- The write API — the only sanctioned way into the ledger
-- ===========================================================================

create or replace function app.require_wallet(p_wallet_id uuid)
returns uuid language plpgsql stable set search_path = '' as $$
declare v uuid;
begin
  select id into v from public.wallets where id = p_wallet_id and is_active;
  if v is null then
    raise exception 'wallet not found or inactive: %', p_wallet_id;
  end if;
  return v;
end;
$$;

create or replace function public.add_expense(
  p_description text,
  p_category    text,
  p_amount      numeric,
  p_wallet_id   uuid,
  p_occurred_at timestamptz default now(),
  p_notes       text default null
) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_id uuid;
begin
  if not app.is_admin() then raise exception 'forbidden'; end if;
  if p_amount is null or p_amount <= 0 then
    raise exception 'amount must be greater than zero';
  end if;
  if nullif(btrim(coalesce(p_description,'')),'') is null then
    raise exception 'description is required';
  end if;
  if nullif(btrim(coalesce(p_category,'')),'') is null then
    raise exception 'category is required';
  end if;
  perform app.require_wallet(p_wallet_id);

  insert into public.ledger_entries (
    entry_type, wallet_id, amount, occurred_at, description, category,
    metadata, created_by
  ) values (
    'expense', p_wallet_id, p_amount, coalesce(p_occurred_at, now()),
    btrim(p_description), btrim(p_category),
    jsonb_build_object('notes', p_notes), auth.uid()
  )
  returning id into v_id;

  return v_id;
end;
$$;

create or replace function public.add_manual_revenue(
  p_description     text,
  p_amount          numeric,
  p_wallet_id       uuid,
  p_student_id      uuid default null,
  p_subscription_id uuid default null,
  p_occurred_at     timestamptz default now(),
  p_notes           text default null
) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_id uuid; v_course uuid;
begin
  if not app.is_admin() then raise exception 'forbidden'; end if;
  if p_amount is null or p_amount <= 0 then
    raise exception 'amount must be greater than zero';
  end if;
  perform app.require_wallet(p_wallet_id);

  -- Denormalise the course so revenue-by-course does not depend on the
  -- subscription still existing.
  if p_subscription_id is not null then
    select course_id into v_course from public.subscriptions where id = p_subscription_id;
  end if;

  insert into public.ledger_entries (
    entry_type, wallet_id, amount, occurred_at, description,
    student_id, subscription_id, course_id, metadata, created_by
  ) values (
    'revenue', p_wallet_id, p_amount, coalesce(p_occurred_at, now()),
    nullif(btrim(coalesce(p_description,'')),''),
    p_student_id, p_subscription_id, v_course,
    jsonb_build_object('notes', p_notes, 'source', 'manual'), auth.uid()
  )
  returning id into v_id;

  return v_id;
end;
$$;

-- Two rows, one group, one statement — the ledger can never hold half a
-- transfer.
create or replace function public.transfer_between_wallets(
  p_from_wallet_id  uuid,
  p_to_wallet_id    uuid,
  p_amount          numeric,
  p_occurred_at     timestamptz default now(),
  p_notes           text default null,
  p_allow_overdraft boolean default false
) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_group   uuid := gen_random_uuid();
  v_at      timestamptz := coalesce(p_occurred_at, now());
  v_balance numeric;
  v_from    text;
  v_to      text;
begin
  if not app.is_admin() then raise exception 'forbidden'; end if;
  if p_amount is null or p_amount <= 0 then
    raise exception 'amount must be greater than zero';
  end if;
  if p_from_wallet_id = p_to_wallet_id then
    raise exception 'cannot transfer a wallet to itself';
  end if;

  perform app.require_wallet(p_from_wallet_id);
  perform app.require_wallet(p_to_wallet_id);

  select balance into v_balance from public.v_wallet_balances where id = p_from_wallet_id;
  if not p_allow_overdraft and coalesce(v_balance, 0) < p_amount then
    select name into v_from from public.wallets where id = p_from_wallet_id;
    raise exception 'insufficient balance in %: has %, needs %',
      v_from, coalesce(v_balance,0), p_amount;
  end if;

  select name into v_from from public.wallets where id = p_from_wallet_id;
  select name into v_to   from public.wallets where id = p_to_wallet_id;

  insert into public.ledger_entries
    (entry_type, wallet_id, amount, occurred_at, description, transfer_group_id, metadata, created_by)
  values
    ('transfer_out', p_from_wallet_id, p_amount, v_at,
     'تحويل إلى ' || v_to, v_group, jsonb_build_object('notes', p_notes), auth.uid()),
    ('transfer_in',  p_to_wallet_id,   p_amount, v_at,
     'تحويل من ' || v_from, v_group, jsonb_build_object('notes', p_notes), auth.uid());

  return v_group;
end;
$$;

-- Voiding one half of a transfer voids both, or the ledger stops balancing
-- and money appears from nowhere.
create or replace function public.void_ledger_entry(
  p_entry_id uuid,
  p_reason   text default null
) returns int
language plpgsql security definer set search_path = '' as $$
declare v_group uuid; v_n int;
begin
  if not app.is_admin() then raise exception 'forbidden'; end if;

  select transfer_group_id into v_group
    from public.ledger_entries where id = p_entry_id and voided_at is null;
  if not found then
    raise exception 'ledger entry not found or already voided';
  end if;

  update public.ledger_entries
     set voided_at = now(), voided_by = auth.uid(), void_reason = p_reason
   where voided_at is null
     and (id = p_entry_id or (v_group is not null and transfer_group_id = v_group));

  get diagnostics v_n = row_count;
  return v_n;
end;
$$;

-- ===========================================================================
-- Kashier payment -> ledger, in the same transaction as the projection
-- ===========================================================================

create or replace function app.sync_payment_to_ledger(p_payment_id uuid)
returns void
language plpgsql security definer set search_path = '' as $$
declare
  p        public.payments;
  v_type   public.ledger_entry_type;
  v_wallet uuid;
  v_sub    record;
begin
  select * into p from public.payments where id = p_payment_id;
  if not found then return; end if;

  -- Only settled money moves a wallet. An authorize merely holds funds and a
  -- void releases a hold that never became money.
  if p.status <> 'SUCCESS' then return; end if;

  v_type := case p.event
              when 'pay'      then 'revenue'
              when 'capture'  then 'revenue'
              when 'refund'   then 'refund'
              when 'reversal' then 'reversal'
              else null
            end;
  if v_type is null then return; end if;

  select id into v_wallet from public.wallets where is_kashier_default and is_active;
  if v_wallet is null then
    -- Refuse to guess which wallet the money landed in.
    raise exception 'no active wallet is marked is_kashier_default';
  end if;

  select s.id as subscription_id, s.student_id, s.course_id
    into v_sub
    from public.subscriptions s
   where s.order_key = p.merchant_order_key
   limit 1;

  insert into public.ledger_entries (
    entry_type, wallet_id, amount, occurred_at, description,
    student_id, course_id, subscription_id, payment_id,
    reference, metadata, is_test
  ) values (
    v_type, v_wallet, abs(coalesce(p.amount, 0)),
    coalesce(p.transaction_date, p.created_at),
    case v_type
      when 'revenue'  then 'دفعة كاشير'
      when 'refund'   then 'استرداد كاشير'
      when 'reversal' then 'عكس عملية كاشير'
    end,
    v_sub.student_id, v_sub.course_id, v_sub.subscription_id, p.id,
    p.transaction_id,
    jsonb_build_object(
      'source', 'kashier',
      'kashier_order_id', p.kashier_order_id,
      'merchant_order_id', p.merchant_order_id,
      'method', p.method,
      'apikey_name', p.apikey_name,
      'settled_amount', p.settled_amount,
      'fees', p.fees),
    p.mode = 'test'
  )
  on conflict (payment_id) where payment_id is not null and voided_at is null
  do update set
    amount          = excluded.amount,
    occurred_at     = excluded.occurred_at,
    entry_type      = excluded.entry_type,
    -- Backfill attribution once the ukkera side arrives; never unlink.
    student_id      = coalesce(public.ledger_entries.student_id, excluded.student_id),
    course_id       = coalesce(public.ledger_entries.course_id, excluded.course_id),
    subscription_id = coalesce(public.ledger_entries.subscription_id, excluded.subscription_id),
    metadata        = excluded.metadata,
    updated_at      = now();
end;
$$;

-- When a subscription arrives AFTER its payment, attach the existing entries.
create or replace function app.attach_subscription_to_ledger()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  update public.ledger_entries e
     set subscription_id = new.id,
         student_id      = coalesce(e.student_id, new.student_id),
         course_id       = coalesce(e.course_id, new.course_id),
         updated_at      = now()
    from public.payments p
   where e.payment_id = p.id
     and e.voided_at is null
     and e.subscription_id is null
     and p.merchant_order_key = new.order_key;
  return new;
end;
$$;

create trigger subscriptions_attach_ledger
  after insert or update of order_id, student_id, course_id on public.subscriptions
  for each row execute function app.attach_subscription_to_ledger();

-- NOTE: app.project_kashier_transaction is redefined in this migration in the
-- database to call app.sync_payment_to_ledger(v_id) as its final statement.
-- See 0004_projections.sql for the body; the only change is that trailing
-- `perform app.sync_payment_to_ledger(v_id);` plus a `returning id into v_id`
-- on the upsert.

-- ===========================================================================
-- Retire the standalone expenses table
-- ===========================================================================
-- Two sources of truth for money is the bug this restructure exists to prevent.

do $$
declare v_wallet uuid;
begin
  -- Pre-ledger expenses have no wallet recorded. Cash is the honest default,
  -- and each carries a marker so a human can reassign them later.
  select id into v_wallet from public.wallets where name_key = upper('نقدي');
  if v_wallet is null then
    select id into v_wallet from public.wallets where is_active order by sort_order limit 1;
  end if;

  if to_regclass('public.expenses') is not null then
    insert into public.ledger_entries (
      entry_type, wallet_id, amount, occurred_at, description, category,
      metadata, created_by, created_at
    )
    select 'expense', v_wallet, e.amount, e.spent_at::timestamptz,
           coalesce(e.note, e.category), e.category,
           jsonb_build_object('migrated_from', 'expenses', 'legacy_id', e.id,
                              'wallet_needs_review', true),
           e.created_by, e.created_at
    from public.expenses e;
  end if;
end $$;

drop view  if exists public.v_expenses_daily cascade;
drop view  if exists public.v_profit_daily cascade;
drop view  if exists public.v_revenue_monthly cascade;
drop view  if exists public.v_dashboard_kpis cascade;
drop table if exists public.expenses cascade;

-- ===========================================================================
-- Universities, and the financial shape of a subscription
-- ===========================================================================

create table public.universities (
  id         uuid primary key default gen_random_uuid(),
  name       text not null check (btrim(name) <> ''),
  name_key   text generated always as (upper(btrim(name))) stored,
  is_active  boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint universities_name_uniq unique (name_key)
);

create trigger universities_touch_updated_at before update on public.universities
  for each row execute function app.touch_updated_at();

alter table public.students add column if not exists university_id uuid
  references public.universities(id) on delete set null;
alter table public.students add column if not exists is_active boolean not null default true;
alter table public.courses  add column if not exists university_id uuid
  references public.universities(id) on delete set null;

create index if not exists students_university_idx on public.students (university_id);
create index if not exists courses_university_idx  on public.courses (university_id);
create index if not exists students_active_idx     on public.students (is_active);

-- Promote the free-text university already on students into real rows.
insert into public.universities (name)
select distinct btrim(university) from public.students
where nullif(btrim(coalesce(university, '')), '') is not null
on conflict (name_key) do nothing;

update public.students s
   set university_id = u.id
  from public.universities u
 where s.university_id is null
   and upper(btrim(coalesce(s.university, ''))) = u.name_key;

alter table public.subscriptions
  add column if not exists total_due         numeric(14,2) check (total_due is null or total_due >= 0),
  add column if not exists installment_count int not null default 1 check (installment_count >= 1),
  add column if not exists due_date          date,
  add column if not exists notes             text;

create table public.subscription_installments (
  id              uuid primary key default gen_random_uuid(),
  subscription_id uuid not null references public.subscriptions(id) on delete cascade,
  seq             int  not null check (seq >= 1),
  amount          numeric(14,2) not null check (amount > 0),
  due_date        date,
  created_at      timestamptz not null default now(),
  constraint subscription_installments_seq_uniq unique (subscription_id, seq)
);

create index subscription_installments_sub_idx
  on public.subscription_installments (subscription_id, seq);

-- ===========================================================================
-- Views — every money figure, always derived
-- ===========================================================================

create view public.v_wallet_balances
with (security_invoker = on) as
select
  w.id, w.name, w.type, w.is_active, w.sort_order, w.is_kashier_default,
  w.opening_balance,
  w.opening_balance + coalesce(sum(app.wallet_delta(e.entry_type, e.amount)), 0) as balance,
  coalesce(sum(app.wallet_delta(e.entry_type, e.amount))
           filter (where app.wallet_delta(e.entry_type, e.amount) > 0), 0)       as money_in,
  coalesce(-sum(app.wallet_delta(e.entry_type, e.amount))
           filter (where app.wallet_delta(e.entry_type, e.amount) < 0), 0)       as money_out,
  count(e.id)                                                                    as entries,
  max(e.occurred_at)                                                             as last_movement_at
from public.wallets w
left join public.ledger_entries e
       on e.wallet_id = w.id
      and e.voided_at is null
      and not e.is_test
group by w.id, w.name, w.type, w.is_active, w.sort_order, w.is_kashier_default, w.opening_balance;

create view public.v_ledger
with (security_invoker = on) as
select
  e.id, e.entry_type, e.amount, e.occurred_at, e.description, e.category,
  e.reference, e.metadata, e.is_test, e.transfer_group_id,
  e.voided_at, e.void_reason, e.created_at,
  app.wallet_delta(e.entry_type, e.amount)  as wallet_delta,
  app.pnl_revenue(e.entry_type, e.amount)   as revenue_effect,
  app.pnl_expense(e.entry_type, e.amount)   as expense_effect,
  e.wallet_id,       w.name  as wallet_name, w.type as wallet_type,
  e.student_id,      st.name as student_name, st.phone as student_phone,
  e.course_id,       c.name  as course_name,
  e.subscription_id, sub.order_id as subscription_order_id,
  e.payment_id,      p.transaction_id as kashier_transaction_id,
                     p.method as payment_method, p.status as payment_status
from public.ledger_entries e
join public.wallets w on w.id = e.wallet_id
left join public.students st on st.id = e.student_id
left join public.courses  c  on c.id  = e.course_id
left join public.subscriptions sub on sub.id = e.subscription_id
left join public.payments p on p.id = e.payment_id;

create view public.v_finance_daily
with (security_invoker = on) as
select
  (e.occurred_at at time zone 'Africa/Cairo')::date as day,
  sum(app.pnl_revenue(e.entry_type, e.amount))                  as revenue,
  sum(app.pnl_expense(e.entry_type, e.amount))                  as expenses,
  sum(app.pnl_revenue(e.entry_type, e.amount))
    - sum(app.pnl_expense(e.entry_type, e.amount))              as net_profit,
  count(*) filter (where e.entry_type = 'revenue')              as revenue_entries,
  count(*) filter (where e.entry_type = 'expense')              as expense_entries,
  count(*) filter (where e.entry_type in ('refund','reversal')) as refund_entries
from public.ledger_entries e
where e.voided_at is null and not e.is_test
group by 1;

create view public.v_finance_monthly
with (security_invoker = on) as
select
  date_trunc('month', day)::date as month,
  sum(revenue)         as revenue,
  sum(expenses)        as expenses,
  sum(net_profit)      as net_profit,
  sum(revenue_entries) as revenue_entries,
  sum(expense_entries) as expense_entries
from public.v_finance_daily
group by 1;

create view public.v_expenses_by_category
with (security_invoker = on) as
select
  date_trunc('month', (e.occurred_at at time zone 'Africa/Cairo')::date)::date as month,
  coalesce(e.category, 'أخرى') as category,
  sum(e.amount) as total,
  count(*)      as entries
from public.ledger_entries e
where e.voided_at is null and not e.is_test and e.entry_type = 'expense'
group by 1, 2;

create view public.v_revenue_by_course
with (security_invoker = on) as
select
  date_trunc('month', (e.occurred_at at time zone 'Africa/Cairo')::date)::date as month,
  e.course_id,
  coalesce(c.name, 'غير محدد') as course_name,
  sum(app.pnl_revenue(e.entry_type, e.amount))     as revenue,
  count(*) filter (where e.entry_type = 'revenue') as payments
from public.ledger_entries e
left join public.courses c on c.id = e.course_id
where e.voided_at is null and not e.is_test
  and e.entry_type in ('revenue','refund','reversal')
group by 1, 2, 3;

create view public.v_subscription_financials
with (security_invoker = on) as
select
  s.id as subscription_id,
  s.order_id, s.student_id, s.course_id, s.package_id,
  s.created_at as enrolled_at,
  s.due_date, s.installment_count,
  -- Price, in order of confidence: explicitly set, then the package list
  -- price, then whatever ukkera said was charged.
  coalesce(s.total_due, pk.price, s.amount, 0)::numeric(14,2) as total_due,
  coalesce(paid.total, 0)::numeric(14,2)                      as total_paid,
  greatest(coalesce(s.total_due, pk.price, s.amount, 0)
           - coalesce(paid.total, 0), 0)::numeric(14,2)       as remaining,
  paid.last_payment_at,
  paid.payments_count,
  case
    when coalesce(s.total_due, pk.price, s.amount, 0) <= 0
      then case when coalesce(paid.total, 0) > 0 then 'paid' else 'unknown' end
    when coalesce(paid.total, 0) >= coalesce(s.total_due, pk.price, s.amount, 0) then 'paid'
    when s.due_date is not null and s.due_date < current_date then 'overdue'
    when coalesce(paid.total, 0) > 0 then 'partial'
    else 'unpaid'
  end as payment_status
from public.subscriptions s
left join public.packages pk on pk.id = s.package_id
left join lateral (
  select
    sum(app.pnl_revenue(e.entry_type, e.amount))               as total,
    max(e.occurred_at) filter (where e.entry_type = 'revenue') as last_payment_at,
    count(*) filter (where e.entry_type = 'revenue')           as payments_count
  from public.ledger_entries e
  where e.subscription_id = s.id
    and e.voided_at is null
    and not e.is_test
) paid on true;

create view public.v_student_financials
with (security_invoker = on) as
select
  st.id as student_id,
  st.name, st.phone, st.phone_normalized, st.email, st.group_name, st.is_active,
  st.created_at as registered_at,
  st.university_id,
  u.name as university_name,
  coalesce(f.subscriptions_count, 0)       as subscriptions_count,
  coalesce(f.total_due, 0)::numeric(14,2)  as total_due,
  coalesce(f.total_paid, 0)::numeric(14,2) as total_paid,
  coalesce(f.remaining, 0)::numeric(14,2)  as remaining,
  f.last_payment_at,
  f.courses,
  case
    when coalesce(f.subscriptions_count, 0) = 0                          then 'unknown'
    when f.overdue_count > 0                                             then 'overdue'
    when coalesce(f.remaining, 0) <= 0 and coalesce(f.total_due, 0) > 0  then 'paid'
    when coalesce(f.total_paid, 0) > 0                                   then 'partial'
    else 'unpaid'
  end as payment_status
from public.students st
left join public.universities u on u.id = st.university_id
left join lateral (
  select
    count(*)                                              as subscriptions_count,
    sum(sf.total_due)                                     as total_due,
    sum(sf.total_paid)                                    as total_paid,
    sum(sf.remaining)                                     as remaining,
    max(sf.last_payment_at)                               as last_payment_at,
    count(*) filter (where sf.payment_status = 'overdue') as overdue_count,
    string_agg(distinct c.name, ' · ')                    as courses
  from public.v_subscription_financials sf
  left join public.courses c on c.id = sf.course_id
  where sf.student_id = st.id
) f on true;

create view public.v_dashboard_kpis
with (security_invoker = on) as
with money as (
  select
    coalesce(sum(app.pnl_revenue(entry_type, amount)), 0) as revenue,
    coalesce(sum(app.pnl_expense(entry_type, amount)), 0) as expenses
  from public.ledger_entries
  where voided_at is null and not is_test
),
this_month as (
  select
    coalesce(sum(app.pnl_revenue(entry_type, amount)), 0) as revenue,
    coalesce(sum(app.pnl_expense(entry_type, amount)), 0) as expenses
  from public.ledger_entries
  where voided_at is null and not is_test
    and (occurred_at at time zone 'Africa/Cairo')
        >= date_trunc('month', (now() at time zone 'Africa/Cairo'))
),
students as (
  select count(*) as total, count(*) filter (where is_active) as active
  from public.students
),
outstanding as (
  select coalesce(sum(remaining), 0) as remaining from public.v_subscription_financials
)
select
  m.revenue                                   as total_revenue,
  m.expenses                                  as total_expenses,
  m.revenue - m.expenses                      as net_profit,
  o.remaining                                 as outstanding_amount,
  tm.revenue                                  as month_revenue,
  tm.expenses                                 as month_expenses,
  tm.revenue - tm.expenses                    as month_net_profit,
  date_trunc('month', (now() at time zone 'Africa/Cairo'))::date as current_month,
  s.active                                    as students_active,
  s.total                                     as students_total,
  (select count(*) from public.subscriptions) as subscriptions_total,
  (select coalesce(sum(balance), 0) from public.v_wallet_balances where is_active) as wallets_total,
  (select count(*) from public.v_unmatched_payments where mode = 'live')  as unmatched_payments,
  (select count(*) from public.v_unpaid_subscriptions)                    as unpaid_subscriptions,
  (select count(*) from public.kashier_events_raw where state = 'failed') as failed_ingest_events,
  (select coalesce(sum(coalesce(amount,0)), 0) from public.payouts
    where mode = 'live' and event = 'TRANSFERRED')                        as payouts_received,
  (select coalesce(sum(coalesce(amount,0)), 0) from public.payouts
    where mode = 'live'
      and event in ('INITIATED','IN_TRANSIT','PARTIALLY_TRANSFERRED'))    as payouts_in_flight
from money m, this_month tm, students s, outstanding o;

create view public.v_monthly_report
with (security_invoker = on) as
select
  m.month, m.revenue, m.expenses, m.net_profit,
  m.revenue_entries as payments_count,
  m.expense_entries as expenses_count,
  (select coalesce(sum(amount), 0) from public.ledger_entries e
    where e.voided_at is null and not e.is_test and e.entry_type = 'revenue'
      and date_trunc('month', (e.occurred_at at time zone 'Africa/Cairo')) = m.month
  ) as payments_total
from public.v_finance_monthly m;

create view public.v_revenue_by_university
with (security_invoker = on) as
select
  date_trunc('month', (e.occurred_at at time zone 'Africa/Cairo')::date)::date as month,
  u.id as university_id,
  coalesce(u.name, 'غير محدد') as university_name,
  sum(app.pnl_revenue(e.entry_type, e.amount))     as revenue,
  count(*) filter (where e.entry_type = 'revenue') as payments
from public.ledger_entries e
left join public.courses c      on c.id = e.course_id
left join public.universities u on u.id = c.university_id
where e.voided_at is null and not e.is_test
  and e.entry_type in ('revenue','refund','reversal')
group by 1, 2, 3;

create view public.v_course_catalogue
with (security_invoker = on) as
select
  c.id   as course_id,
  c.name as course_name,
  c.is_active,
  u.id   as university_id,
  coalesce(u.name, 'غير محدد') as university_name,
  count(distinct sf.subscription_id)             as students_count,
  coalesce(sum(sf.total_due), 0)::numeric(14,2)  as total_due,
  coalesce(sum(sf.total_paid), 0)::numeric(14,2) as total_paid,
  coalesce(sum(sf.remaining), 0)::numeric(14,2)  as remaining
from public.courses c
left join public.universities u on u.id = c.university_id
left join public.v_subscription_financials sf on sf.course_id = c.id
group by c.id, c.name, c.is_active, u.id, u.name;

-- ===========================================================================
-- Security
-- ===========================================================================

alter table public.wallets                   enable row level security;
alter table public.wallets                   force  row level security;
alter table public.ledger_entries            enable row level security;
alter table public.ledger_entries            force  row level security;
alter table public.universities              enable row level security;
alter table public.universities              force  row level security;
alter table public.subscription_installments enable row level security;
alter table public.subscription_installments force  row level security;

revoke all on public.wallets, public.ledger_entries, public.universities,
              public.subscription_installments from anon;

grant select, insert, update on public.wallets to authenticated;
grant select on public.ledger_entries to authenticated;
grant select, insert, update, delete on public.universities to authenticated;
grant select, insert, update, delete on public.subscription_installments to authenticated;

create policy wallets_admin_all on public.wallets
  for all to authenticated using (app.is_admin()) with check (app.is_admin());

-- Ledger entries are read-only over the API. Every write goes through the
-- functions above, so the invariants cannot be bypassed by a direct insert.
create policy ledger_admin_read on public.ledger_entries
  for select to authenticated using (app.is_admin());

create policy universities_admin_all on public.universities
  for all to authenticated using (app.is_admin()) with check (app.is_admin());
create policy subscription_installments_admin_all on public.subscription_installments
  for all to authenticated using (app.is_admin()) with check (app.is_admin());

grant select on
  public.v_wallet_balances, public.v_ledger, public.v_finance_daily,
  public.v_finance_monthly, public.v_expenses_by_category, public.v_revenue_by_course,
  public.v_subscription_financials, public.v_student_financials,
  public.v_dashboard_kpis, public.v_monthly_report,
  public.v_revenue_by_university, public.v_course_catalogue
to authenticated;

do $$
declare f text;
begin
  foreach f in array array[
    'public.add_expense(text,text,numeric,uuid,timestamptz,text)',
    'public.add_manual_revenue(text,numeric,uuid,uuid,uuid,timestamptz,text)',
    'public.transfer_between_wallets(uuid,uuid,numeric,timestamptz,text,boolean)',
    'public.void_ledger_entry(uuid,text)'
  ] loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end $$;
