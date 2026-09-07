-- 0002_core_schema.sql
-- Domain tables: people, catalogue, subscriptions, money.
--
-- Design note on the payments <-> subscriptions relationship:
-- The working hypothesis is that ukkera's `order_id` equals Kashier's
-- `merchantOrderId`. That is NOT verified yet, so it is deliberately modelled
-- as a *soft* join on a normalised key plus a manual override table, never as
-- a foreign key. A wrong FK would reject real payments at ingest time; a wrong
-- soft join merely shows up in the "unmatched" report, where it can be fixed.

create extension if not exists pg_trgm with schema extensions;

-- ---------------------------------------------------------------------------
-- People and catalogue
-- ---------------------------------------------------------------------------

create table public.students (
  id                uuid primary key default gen_random_uuid(),
  ukkera_student_id text unique,
  name              text not null check (btrim(name) <> ''),
  phone             text,
  phone_normalized  text generated always as (app.normalize_phone(phone)) stored,
  email             text,
  group_name        text,
  university        text,
  notes             text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

-- Phone is the practical natural key coming out of the ukkera webhook, but it
-- is not guaranteed unique (siblings sharing a number). Non-unique index only.
create index students_phone_normalized_idx on public.students (phone_normalized)
  where phone_normalized is not null;
create index students_name_trgm_idx on public.students using gin (name gin_trgm_ops);

create table public.courses (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  name_key   text generated always as (upper(btrim(name))) stored,
  is_active  boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint courses_name_key_uniq unique (name_key)
);

create table public.packages (
  id         uuid primary key default gen_random_uuid(),
  course_id  uuid references public.courses(id) on delete cascade,
  name       text not null,
  name_key   text generated always as (upper(btrim(name))) stored,
  price      numeric(14,2) check (price is null or price >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint packages_course_name_uniq unique (course_id, name_key)
);

-- ---------------------------------------------------------------------------
-- Subscriptions — the ukkera side of the world
-- ---------------------------------------------------------------------------

create table public.subscriptions (
  id            uuid primary key default gen_random_uuid(),
  student_id    uuid references public.students(id) on delete set null,
  course_id     uuid references public.courses(id) on delete set null,
  package_id    uuid references public.packages(id) on delete set null,

  order_id      text not null,
  -- The join key against payments.merchant_order_key. Generated, so it can
  -- never drift out of sync with order_id.
  order_key     text generated always as (app.normalize_order_id(order_id)) stored,

  amount        numeric(14,2) check (amount is null or amount >= 0),
  currency      text not null default 'EGP',
  payment_date  date,
  source        text not null default 'ukkera_webhook'
                  check (source in ('ukkera_webhook','import','manual')),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  constraint subscriptions_order_key_uniq unique (order_key)
);

create index subscriptions_student_idx on public.subscriptions (student_id);
create index subscriptions_course_idx  on public.subscriptions (course_id);
create index subscriptions_created_idx on public.subscriptions (created_at desc);

-- ---------------------------------------------------------------------------
-- Payments — the Kashier side of the world
-- ---------------------------------------------------------------------------
-- One row per Kashier transaction. A refund/void/reversal is its own
-- transaction and therefore its own row; `event` says which kind it is.

create table public.payments (
  id                  uuid primary key default gen_random_uuid(),

  transaction_id      text not null,
  kashier_order_id    text,
  merchant_order_id   text,
  merchant_order_key  text generated always as (app.normalize_order_id(merchant_order_id)) stored,
  order_reference     text,

  event               public.kashier_txn_event not null,
  status              public.txn_status not null default 'UNKNOWN',
  mode                public.kashier_mode not null default 'live',

  amount              numeric(14,2),
  currency            text default 'EGP',
  settled_amount      numeric(14,2),
  fees                numeric(14,2),
  vat                 numeric(14,2),

  method              text,
  channel             text,
  card_brand          text,
  masked_card         text,
  card_holder_name    text,
  apikey_name         text,

  transaction_date    timestamptz,
  response_code       text,
  response_message    text,

  is_test_webhook     boolean not null default false,
  raw_payload         jsonb not null default '{}'::jsonb,

  first_seen_at       timestamptz not null default now(),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),

  -- A transaction id is only unique within a mode; test and live traffic must
  -- never collide with each other.
  constraint payments_txn_mode_uniq unique (transaction_id, mode)
);

create index payments_merchant_order_key_idx on public.payments (merchant_order_key)
  where merchant_order_key is not null;
create index payments_status_idx      on public.payments (status);
create index payments_event_idx       on public.payments (event);
create index payments_txn_date_idx    on public.payments (transaction_date desc);
create index payments_apikey_name_idx on public.payments (apikey_name);
-- Fast path for the revenue views, which only ever look at successful money in.
create index payments_success_idx on public.payments (transaction_date desc)
  where status = 'SUCCESS';

-- ---------------------------------------------------------------------------
-- Payouts — Kashier transfer events
-- ---------------------------------------------------------------------------
-- The exact transfer payload shape is not documented publicly yet, so this
-- table stores the fields we are confident about and keeps the full body in
-- raw_payload. Columns can be widened later without losing history.

create table public.payouts (
  id            uuid primary key default gen_random_uuid(),
  transfer_id   text not null,
  event         public.kashier_transfer_event not null,
  mode          public.kashier_mode not null default 'live',
  amount        numeric(14,2),
  currency      text default 'EGP',
  reference     text,
  transfer_date timestamptz,
  raw_payload   jsonb not null default '{}'::jsonb,
  first_seen_at timestamptz not null default now(),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  constraint payouts_transfer_mode_uniq unique (transfer_id, mode)
);

create index payouts_event_idx on public.payouts (event);
create index payouts_date_idx  on public.payouts (transfer_date desc);

-- ---------------------------------------------------------------------------
-- Manual match overrides
-- ---------------------------------------------------------------------------
-- Escape hatch for when the order_id == merchantOrderId assumption does not
-- hold for a given payment. An override always wins over the automatic join.

create table public.payment_subscription_overrides (
  payment_id      uuid primary key references public.payments(id) on delete cascade,
  subscription_id uuid not null references public.subscriptions(id) on delete cascade,
  reason          text,
  created_by      uuid references auth.users(id) on delete set null,
  created_at      timestamptz not null default now()
);

create index pso_subscription_idx on public.payment_subscription_overrides (subscription_id);

-- ---------------------------------------------------------------------------
-- Expenses
-- ---------------------------------------------------------------------------

create table public.expenses (
  id         uuid primary key default gen_random_uuid(),
  category   text not null,
  amount     numeric(14,2) not null check (amount >= 0),
  currency   text not null default 'EGP',
  note       text,
  spent_at   date not null default current_date,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index expenses_spent_at_idx on public.expenses (spent_at desc);
create index expenses_category_idx on public.expenses (category);

-- ---------------------------------------------------------------------------
-- updated_at triggers
-- ---------------------------------------------------------------------------

do $$
declare t text;
begin
  foreach t in array array[
    'students','courses','packages','subscriptions','payments','payouts','expenses'
  ] loop
    execute format(
      'create trigger %I before update on public.%I
         for each row execute function app.touch_updated_at()',
      t || '_touch_updated_at', t);
  end loop;
end $$;
