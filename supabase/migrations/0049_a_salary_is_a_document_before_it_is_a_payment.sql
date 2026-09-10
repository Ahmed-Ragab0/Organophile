-- Payroll, part one: the shape of it.
--
-- Until now the only way a salary reached this system was as a line in the
-- expenses screen — "مرتبات، 6000، من فودافون كاش" — which is enough to keep
-- the books balanced and answers nothing else. It cannot say who was paid,
-- what the figure was made of, whether it was agreed before it was sent, or
-- what anybody is owed next month.
--
-- So a salary becomes a DOCUMENT first and a payment second:
--
--   employee   → who is paid, and what their base is
--   period     → a month, moving through draft → review → approved → closed
--   payslip    → one employee's figure for one month, with its own history
--   items      → what the figure is made of, one line per commission,
--                bonus, allowance or deduction
--
-- Paying is then a separate act (0050) that turns an approved payslip into an
-- expense in the ledger. That order is the whole point: a payslip exists,
-- gets checked, and gets approved BEFORE money moves, and once money has
-- moved the document is frozen.
--
-- Three things are deliberately NOT here:
--
--   * Automatic commission. Computing "5% of what this person sold" needs
--     sales to be attributed to a person, and nothing in this database
--     attributes them yet. A commission is a typed line with a note until
--     that exists; the shape is ready for it, the arithmetic is not invented.
--   * A pay grade / contract table. One base figure per person is what this
--     business has. A second table would be modelling somebody else's payroll.
--   * Self-service. An employee cannot read their own payslip, because an
--     employee is not necessarily a login at all. The link exists for the day
--     that changes.

-- ---------------------------------------------------------------------------
-- What there is to be allowed to do
-- ---------------------------------------------------------------------------
-- Salaries are the most confidential figures in the business, so they get
-- their own domain rather than riding on `money.*`: an accountant who
-- reconciles Kashier does not automatically get to read what everyone earns.
--
-- `payroll.write` INCLUDES paying, which moves real money out of a wallet.
-- That is stated here because it is the one permission in this system whose
-- name does not contain the word money and yet spends it — granting it is a
-- money decision, not an HR one.
insert into public.permissions (code, domain, action, name, name_en, sort_order) values
  ('payroll.read',  'payroll', 'read',  'يشوف المرتبات',            'View payroll',   54),
  ('payroll.write', 'payroll', 'write', 'يجهّز ويصرف المرتبات',     'Run payroll',    55)
on conflict (code) do update
  set domain = excluded.domain, action = excluded.action,
      name = excluded.name, name_en = excluded.name_en,
      sort_order = excluded.sort_order;

-- The accountant is the role that already handles money going out, so it is
-- the one that gets payroll by default. Sales and viewer deliberately do not:
-- "every .read except staff" was written before salaries existed, and a list
-- of what colleagues earn is not a report.
insert into public.role_permissions (role_id, permission_code)
select r.id, p.code
  from public.roles r
  cross join (values ('payroll.read'), ('payroll.write')) as p(code)
 where r.code = 'accountant'
on conflict do nothing;

-- ---------------------------------------------------------------------------
-- The people who get paid
-- ---------------------------------------------------------------------------
-- Separate from `staff` on purpose. `staff` answers "who may sign in"; this
-- answers "who is on the payroll", and the two sets overlap without being the
-- same one: the assistant who is paid in cash has no login, and the owner has
-- a login and no salary. Joining them into one table would force every paid
-- person to be given an email and a password to exist.
create table if not exists public.employees (
  id          uuid primary key default gen_random_uuid(),
  full_name   text not null check (btrim(full_name) <> ''),
  job_title   text,
  -- The WhatsApp destination. Stored as typed; normalised at the point of
  -- sending, because the same person's number is written four ways in a phone
  -- book and none of them is wrong.
  phone       text,
  email       text,
  /**
   * The login, when this person has one.
   *
   * Points at `staff`, not at `auth.users`: a row in `auth.users` that is not
   * in `staff` cannot use this system at all, so linking to it would record a
   * relationship that means nothing. ON DELETE SET NULL — removing somebody's
   * access is not the same act as taking them off the payroll, and doing the
   * first must never quietly do the second.
   */
  user_id     uuid unique references public.staff(user_id) on delete set null,
  base_salary numeric(14,2) not null default 0 check (base_salary >= 0),
  -- Where this person's salary usually comes from. A default, not a rule:
  -- every payment names its own wallet.
  wallet_id   uuid references public.wallets(id) on delete set null,
  hired_on    date,
  ended_on    date,
  is_active   boolean not null default true,
  note        text,
  created_by  uuid references auth.users(id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint employees_dates_ordered check (
    ended_on is null or hired_on is null or ended_on >= hired_on)
);

comment on table public.employees is
  'Who is on the payroll. Not the same list as `staff`: that one is who may '
  'sign in, and being paid and being able to log in are different facts.';

create index if not exists employees_active_idx on public.employees (is_active, full_name);

drop trigger if exists employees_touch_updated_at on public.employees;
create trigger employees_touch_updated_at
  before update on public.employees
  for each row execute function app.touch_updated_at();

-- ---------------------------------------------------------------------------
-- What a salary is made of
-- ---------------------------------------------------------------------------
-- The same argument as expense categories and package types: this is the
-- vocabulary of the business, so it is rows. The owner adds "بدل مواصلات" or
-- "خصم تأمينات" without a deploy.
--
-- `direction` is not editable vocabulary — it is arithmetic. A component
-- either adds to the salary or takes away from it, and the two-value check is
-- the sign in the sum.
create table if not exists public.salary_components (
  id         uuid primary key default gen_random_uuid(),
  code       text unique,
  name       text not null check (btrim(name) <> ''),
  name_en    text,
  direction  text not null check (direction in ('earning', 'deduction')),
  /**
   * Seeded and read by name somewhere. `commission` and `bonus` are the two
   * that matter: the thank-you message has a {commissions} and a {bonus}
   * variable, so those two codes are branched on and must keep existing.
   * Renameable, never deletable — exactly like a system package kind.
   */
  is_system  boolean not null default false,
  is_active  boolean not null default true,
  sort_order int not null default 100,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.salary_components is
  'The lines a payslip can carry. Owned by the business, except `direction`, '
  'which is the sign in the arithmetic rather than a name.';

create or replace function app.salary_component_code()
returns trigger language plpgsql set search_path = '' as $function$
begin
  if nullif(btrim(coalesce(new.code, '')), '') is null then
    new.code := 'sc_' || substr(md5(upper(btrim(new.name))), 1, 10);
  end if;
  return new;
end;
$function$;

drop trigger if exists salary_components_fill_code on public.salary_components;
create trigger salary_components_fill_code
  before insert on public.salary_components
  for each row execute function app.salary_component_code();

drop trigger if exists salary_components_touch_updated_at on public.salary_components;
create trigger salary_components_touch_updated_at
  before update on public.salary_components
  for each row execute function app.touch_updated_at();

insert into public.salary_components (code, name, name_en, direction, is_system, sort_order)
values
  ('commission', 'عمولة',          'Commission',  'earning',   true,  10),
  ('bonus',      'حافز',           'Bonus',       'earning',   true,  20),
  ('allowance',  'بدل',            'Allowance',   'earning',   false, 30),
  ('overtime',   'ساعات إضافية',   'Overtime',    'earning',   false, 40),
  ('advance',    'سلفة',           'Advance',     'deduction', false, 60),
  ('absence',    'خصم غياب',       'Absence',     'deduction', false, 70),
  ('penalty',    'خصم',            'Deduction',   'deduction', false, 80),
  ('insurance',  'تأمينات',        'Insurance',   'deduction', false, 90)
on conflict (code) do update
  set name = excluded.name, name_en = excluded.name_en,
      direction = excluded.direction, is_system = excluded.is_system;

-- ---------------------------------------------------------------------------
-- A month of payroll
-- ---------------------------------------------------------------------------
-- `status` is a text check rather than its own table, and the reason is the
-- same one that keeps the permission catalogue out of the app: the code
-- branches on every one of these four values. A fifth invented from a screen
-- would be a status nothing knows how to handle.
create table if not exists public.payroll_periods (
  id           uuid primary key default gen_random_uuid(),
  -- Always the first of the month; the trigger below normalises it, so a date
  -- picked anywhere in September lands on the September cycle.
  period_month date not null unique,
  status       text not null default 'draft'
               check (status in ('draft', 'review', 'approved', 'closed')),
  note         text,
  approved_by  uuid references auth.users(id) on delete set null,
  approved_at  timestamptz,
  closed_at    timestamptz,
  created_by   uuid references auth.users(id) on delete set null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  constraint payroll_periods_month_is_first check (extract(day from period_month) = 1)
);

comment on table public.payroll_periods is
  'One month of payroll, moving draft → review → approved → closed. Nothing '
  'is paid before approved, and nothing changes after paid.';

drop trigger if exists payroll_periods_touch_updated_at on public.payroll_periods;
create trigger payroll_periods_touch_updated_at
  before update on public.payroll_periods
  for each row execute function app.touch_updated_at();

-- ---------------------------------------------------------------------------
-- One person's month
-- ---------------------------------------------------------------------------
create table if not exists public.payslips (
  id          uuid primary key default gen_random_uuid(),
  period_id   uuid not null references public.payroll_periods(id) on delete cascade,
  -- RESTRICT, not CASCADE: an employee who has ever been paid is part of the
  -- financial record and cannot be deleted out from under it.
  employee_id uuid not null references public.employees(id) on delete restrict,

  /**
   * Snapshots, taken when the payslip is created.
   *
   * A payslip is a document about a month that has already happened. Reading
   * the name and the job title live off `employees` would mean a promotion in
   * November silently rewrites what October's payslip says — which is exactly
   * the thing a payslip exists to prevent.
   */
  employee_name text not null,
  job_title     text,
  phone         text,

  base_salary      numeric(14,2) not null default 0 check (base_salary >= 0),
  -- Maintained by trigger from the items. Never written by a client: the
  -- items are the truth and these are their sum.
  earnings_total   numeric(14,2) not null default 0 check (earnings_total >= 0),
  deductions_total numeric(14,2) not null default 0 check (deductions_total >= 0),

  -- Generated, so the two figures everybody actually reads cannot drift from
  -- the three they are made of. Stored, so they can be indexed and summed.
  gross_amount numeric(14,2)
    generated always as (base_salary + earnings_total) stored,
  net_amount   numeric(14,2)
    generated always as (base_salary + earnings_total - deductions_total) stored,

  note text,

  -- Set only by `pay_payslip`; see the guard below.
  paid_at         timestamptz,
  paid_wallet_id  uuid references public.wallets(id) on delete restrict,
  ledger_entry_id uuid unique references public.ledger_entries(id) on delete restrict,

  -- When the thank-you actually went out. Recorded so nobody is thanked twice
  -- and nobody is missed; it changes no figure, which is why it is the one
  -- field a paid payslip still accepts.
  message_sent_at timestamptz,

  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint payslips_one_per_employee_per_period unique (period_id, employee_id),
  -- Paid means there is an entry in the ledger. Neither half without the other.
  constraint payslips_paid_has_an_entry check ((paid_at is null) = (ledger_entry_id is null)),
  constraint payslips_net_not_negative check (
    base_salary + earnings_total - deductions_total >= 0)
);

comment on table public.payslips is
  'One employee''s figure for one month. Frozen once paid, because a document '
  'that can change after the money left is not a record of anything.';

create index if not exists payslips_period_idx   on public.payslips (period_id);
create index if not exists payslips_employee_idx on public.payslips (employee_id);
create index if not exists payslips_unpaid_idx   on public.payslips (period_id)
  where paid_at is null;

drop trigger if exists payslips_touch_updated_at on public.payslips;
create trigger payslips_touch_updated_at
  before update on public.payslips
  for each row execute function app.touch_updated_at();

-- ---------------------------------------------------------------------------
-- What the figure is made of
-- ---------------------------------------------------------------------------
create table if not exists public.payslip_items (
  id           uuid primary key default gen_random_uuid(),
  payslip_id   uuid not null references public.payslips(id) on delete cascade,
  component_id uuid not null references public.salary_components(id) on delete restrict,
  /**
   * Snapshot of the component's direction at the moment the line was written.
   *
   * A component flipped from earning to deduction later must not silently
   * re-sign a line somebody has already agreed to. Filled by trigger, never
   * by the client.
   */
  direction    text not null check (direction in ('earning', 'deduction')),
  -- What this line is FOR: "عمولة 5% على 12 اشتراك". Defaults to the
  -- component's name, because a line that says only "خصم" answers nothing in
  -- three months' time.
  label        text,
  amount       numeric(14,2) not null check (amount > 0),
  created_by   uuid references auth.users(id) on delete set null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

comment on table public.payslip_items is
  'The lines of a payslip. Their sum is the payslip''s totals — kept by '
  'trigger, so the two can never disagree.';

create index if not exists payslip_items_payslip_idx   on public.payslip_items (payslip_id);
create index if not exists payslip_items_component_idx on public.payslip_items (component_id);

drop trigger if exists payslip_items_touch_updated_at on public.payslip_items;
create trigger payslip_items_touch_updated_at
  before update on public.payslip_items
  for each row execute function app.touch_updated_at();

-- ---------------------------------------------------------------------------
-- The message, and where salaries are filed
-- ---------------------------------------------------------------------------
-- One row, forever: `id` is a boolean CHECKed to true, so a second row is not
-- something a bug can produce.
create table if not exists public.payroll_settings (
  id           boolean primary key default true check (id),
  company_name text not null default 'أكاديمية الكيمياء العضوية',
  /**
   * The thank-you note, with {placeholders} the front end fills in.
   *
   * Stored rather than hard-coded because it is the owner's voice, not the
   * system's — and because the wording of the message that reaches somebody
   * about their salary is not a thing that should need a deploy.
   */
  thanks_template text not null,
  -- Printed at the bottom of the payslip document.
  invoice_note text,
  default_wallet_id uuid references public.wallets(id) on delete set null,
  -- Which expense category salaries land in. Resolved once here rather than
  -- spelled out at every payment, so a rename reaches every future salary.
  expense_category_id uuid references public.expense_categories(id) on delete set null,
  updated_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz not null default now()
);

comment on table public.payroll_settings is
  'One row. The company name, the thank-you template, and where salaries are '
  'filed in the books.';

drop trigger if exists payroll_settings_touch_updated_at on public.payroll_settings;
create trigger payroll_settings_touch_updated_at
  before update on public.payroll_settings
  for each row execute function app.touch_updated_at();

insert into public.payroll_settings (id, thanks_template, expense_category_id)
values (
  true,
  -- One literal, not six concatenated ones: PostgreSQL only continues a string
  -- across lines when the continuation has no prefix, and `E'…' E'…'` is a
  -- syntax error rather than a concatenation.
  E'جزاك الله خيرًا يا {name} 🌟\nنشكرك على جهودك ومثابرتك في {company}.\n\nراتبك عن شهر {month} {year} وقدره {net} جنيه قد تم صرفه بتاريخ {paidDate} عبر {paidWallet}.\n\nنسأل الله أن يبارك لك فيه ويزيدك من فضله 🤲',
  (select id from public.expense_categories where name_key = upper('مرتبات') limit 1)
)
on conflict (id) do nothing;

-- ===========================================================================
-- The rails
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- Who wrote this row
-- ---------------------------------------------------------------------------
-- `created_by` used to be whatever the client chose to send, which is a field
-- that records nothing: a row can claim any author. Stamped from `auth.uid()`
-- instead, in a trigger the client cannot reach.
create or replace function app.stamp_created_by()
returns trigger language plpgsql set search_path = '' as $function$
begin
  new.created_by := auth.uid();
  return new;
end;
$function$;

do $$
declare t text;
begin
  foreach t in array array[
    'employees', 'payroll_periods', 'payslips', 'payslip_items'
  ] loop
    execute format('drop trigger if exists %I on public.%I', t || '_stamp_author', t);
    execute format(
      'create trigger %I before insert on public.%I '
      'for each row execute function app.stamp_created_by()',
      t || '_stamp_author', t);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- The totals are the items' sum, and nothing else
-- ---------------------------------------------------------------------------
create or replace function app.recalc_payslip(p_payslip uuid)
returns void language plpgsql security definer set search_path = '' as $function$
declare
  v_earn numeric(14,2);
  v_ded  numeric(14,2);
  v_base numeric(14,2);
begin
  select base_salary into v_base from public.payslips where id = p_payslip;
  if not found then return; end if;

  select coalesce(sum(amount) filter (where direction = 'earning'),   0),
         coalesce(sum(amount) filter (where direction = 'deduction'), 0)
    into v_earn, v_ded
    from public.payslip_items where payslip_id = p_payslip;

  if v_base + v_earn - v_ded < 0 then
    raise exception 'deductions exceed the salary' using errcode = 'check_violation';
  end if;

  update public.payslips
     set earnings_total = v_earn, deductions_total = v_ded, updated_at = now()
   where id = p_payslip
     and (earnings_total, deductions_total) is distinct from (v_earn, v_ded);
end;
$function$;

comment on function app.recalc_payslip is
  'Re-sums one payslip from its lines. The only writer of earnings_total and '
  'deductions_total.';

create or replace function app.payslip_items_recalc()
returns trigger language plpgsql security definer set search_path = '' as $function$
begin
  perform app.recalc_payslip(
    case when tg_op = 'DELETE' then old.payslip_id else new.payslip_id end);
  -- An item moved between payslips has to leave both of them correct.
  if tg_op = 'UPDATE' and new.payslip_id is distinct from old.payslip_id then
    perform app.recalc_payslip(old.payslip_id);
  end if;
  return null;
end;
$function$;

-- ---------------------------------------------------------------------------
-- A paid payslip is a closed document
-- ---------------------------------------------------------------------------
-- The transaction-local flag is how `pay_payslip` says "this write is mine".
-- Without it, anyone holding `payroll.write` could mark a payslip paid with a
-- plain UPDATE through PostgREST and no money would ever leave a wallet — the
-- exact class of bug rule 8 exists to prevent on the ledger side.
create or replace function app.payroll_is_paying()
returns boolean language sql stable set search_path = '' as $$
  select coalesce(current_setting('app.payroll_paying', true), '') = 'on'
$$;

create or replace function app.guard_payslip()
returns trigger language plpgsql set search_path = '' as $function$
declare
  v_paying boolean := app.payroll_is_paying();
  v_status text;
begin
  if tg_op = 'DELETE' then
    if old.paid_at is not null then
      raise exception 'a paid payslip cannot be deleted, only reversed'
        using errcode = 'restrict_violation';
    end if;
    return old;
  end if;

  if tg_op = 'INSERT' then
    if new.paid_at is not null then
      raise exception 'a payslip is paid through pay_payslip, not created paid'
        using errcode = 'restrict_violation';
    end if;
    select status into v_status from public.payroll_periods where id = new.period_id;
    if v_status in ('approved', 'closed') then
      raise exception 'this cycle is already approved; reopen it to add anybody'
        using errcode = 'restrict_violation';
    end if;
    return new;
  end if;

  -- UPDATE from here down.
  if not v_paying
     and (new.paid_at is distinct from old.paid_at
          or new.paid_wallet_id is distinct from old.paid_wallet_id
          or new.ledger_entry_id is distinct from old.ledger_entry_id) then
    raise exception 'a payslip is paid through pay_payslip, not by writing to it'
      using errcode = 'restrict_violation';
  end if;

  /*
   * Once the money has gone, every figure is history. `message_sent_at` is
   * the deliberate exception: thanking somebody happens after the transfer
   * and changes nothing about what they were paid.
   */
  if old.paid_at is not null and not v_paying
     and (new.base_salary      is distinct from old.base_salary
       or new.earnings_total   is distinct from old.earnings_total
       or new.deductions_total is distinct from old.deductions_total
       or new.employee_id      is distinct from old.employee_id
       or new.period_id        is distinct from old.period_id
       or new.employee_name    is distinct from old.employee_name
       or new.job_title        is distinct from old.job_title
       or new.note             is distinct from old.note) then
    raise exception 'a paid payslip cannot be changed'
      using errcode = 'restrict_violation';
  end if;

  return new;
end;
$function$;

drop trigger if exists payslips_guard on public.payslips;
create trigger payslips_guard
  before insert or update or delete on public.payslips
  for each row execute function app.guard_payslip();

create or replace function app.guard_payslip_item()
returns trigger language plpgsql set search_path = '' as $function$
declare
  v_paid timestamptz;
  v_dir  text;
  v_name text;
begin
  select paid_at into v_paid from public.payslips
   where id = case when tg_op = 'DELETE' then old.payslip_id else new.payslip_id end;
  if v_paid is not null then
    raise exception 'a paid payslip cannot be changed' using errcode = 'restrict_violation';
  end if;

  if tg_op = 'DELETE' then return old; end if;

  if tg_op = 'INSERT' or new.component_id is distinct from old.component_id then
    select c.direction, c.name into v_dir, v_name
      from public.salary_components c where c.id = new.component_id;
    if v_dir is null then
      raise exception 'unknown salary component' using errcode = 'foreign_key_violation';
    end if;
    new.direction := v_dir;
    if nullif(btrim(coalesce(new.label, '')), '') is null then
      new.label := v_name;
    end if;
  end if;

  return new;
end;
$function$;

drop trigger if exists payslip_items_guard on public.payslip_items;
create trigger payslip_items_guard
  before insert or update or delete on public.payslip_items
  for each row execute function app.guard_payslip_item();

drop trigger if exists payslip_items_recalc on public.payslip_items;
create trigger payslip_items_recalc
  after insert or update or delete on public.payslip_items
  for each row execute function app.payslip_items_recalc();

-- ---------------------------------------------------------------------------
-- A cycle only moves forwards once money has moved
-- ---------------------------------------------------------------------------
create or replace function app.guard_payroll_period()
returns trigger language plpgsql set search_path = '' as $function$
declare
  v_paid  int;
  v_total int;
begin
  if tg_op = 'DELETE' then
    if exists (select 1 from public.payslips
                where period_id = old.id and paid_at is not null) then
      raise exception 'a cycle with salaries already paid cannot be deleted'
        using errcode = 'restrict_violation';
    end if;
    return old;
  end if;

  -- Any day in the month means that month. Rejecting the 15th would be
  -- technically correct and useless.
  new.period_month := date_trunc('month', new.period_month)::date;

  if tg_op = 'INSERT' then
    new.status := coalesce(new.status, 'draft');
    return new;
  end if;

  select count(*) filter (where paid_at is not null), count(*)
    into v_paid, v_total
    from public.payslips where period_id = new.id;

  if new.period_month is distinct from old.period_month and v_total > 0 then
    raise exception 'the month cannot change once the cycle has payslips'
      using errcode = 'restrict_violation';
  end if;

  if v_paid > 0 and new.status in ('draft', 'review') then
    raise exception 'salaries in this cycle are already paid'
      using errcode = 'restrict_violation';
  end if;

  if new.status = 'closed' and v_paid < v_total then
    raise exception 'the cycle cannot close while a salary is unpaid'
      using errcode = 'restrict_violation';
  end if;

  -- Who approved it and when, stamped rather than trusted from the client.
  if new.status = 'approved' and old.status is distinct from 'approved' then
    new.approved_at := now();
    new.approved_by := auth.uid();
  elsif new.status in ('draft', 'review') then
    new.approved_at := null;
    new.approved_by := null;
  end if;

  new.closed_at := case when new.status = 'closed' then coalesce(old.closed_at, now()) end;

  return new;
end;
$function$;

drop trigger if exists payroll_periods_guard on public.payroll_periods;
create trigger payroll_periods_guard
  before insert or update or delete on public.payroll_periods
  for each row execute function app.guard_payroll_period();

-- ---------------------------------------------------------------------------
-- A salary in the ledger belongs to its payslip
-- ---------------------------------------------------------------------------
-- Voiding the expense from the ledger screen while the payslip still says
-- "paid" would leave two records of one fact disagreeing. The reversal has a
-- door of its own (`unpay_payslip`, 0050); this closes the other one.
create or replace function app.guard_ledger_payroll_void()
returns trigger language plpgsql set search_path = '' as $function$
begin
  if new.voided_at is not null and old.voided_at is null
     and not app.payroll_is_paying()
     and exists (select 1 from public.payslips where ledger_entry_id = old.id) then
    raise exception 'this entry belongs to a payslip — reverse the payslip instead'
      using errcode = 'restrict_violation';
  end if;
  return new;
end;
$function$;

drop trigger if exists ledger_entries_guard_payroll_void on public.ledger_entries;
create trigger ledger_entries_guard_payroll_void
  before update of voided_at on public.ledger_entries
  for each row execute function app.guard_ledger_payroll_void();

-- ===========================================================================
-- Security
-- ===========================================================================
do $do$
declare
  m         text[];
  tbl       text;
  read_perm text;
  write_perm text;
begin
  foreach m slice 1 in array array[
    ['employees',         'payroll.read', 'payroll.write'],
    ['salary_components', 'payroll.read', 'payroll.write'],
    ['payroll_periods',   'payroll.read', 'payroll.write'],
    ['payslips',          'payroll.read', 'payroll.write'],
    ['payslip_items',     'payroll.read', 'payroll.write'],
    ['payroll_settings',  'payroll.read', 'payroll.write']
  ] loop
    tbl := m[1]; read_perm := m[2]; write_perm := m[3];

    execute format('alter table public.%I enable row level security', tbl);
    execute format('alter table public.%I force row level security', tbl);
    execute format('revoke all on public.%I from anon, authenticated', tbl);
    execute format('grant select, insert, update, delete on public.%I to authenticated', tbl);
    execute format('grant all on public.%I to service_role', tbl);
    -- 0037 revoked these from every table that existed then, and from future
    -- ones by default privilege. Both are the same statement; neither is
    -- retroactive to a table created afterwards by a different role.
    execute format(
      'revoke truncate, references, trigger, maintain on public.%I from anon, authenticated',
      tbl);

    execute format('drop policy if exists %I on public.%I', tbl || '_read', tbl);
    execute format(
      'create policy %I on public.%I for select to authenticated using (app.can(%L))',
      tbl || '_read', tbl, read_perm);

    -- The singleton is updated, never removed: every screen reads it
    -- unconditionally, and a missing row is a blank company name on a payslip.
    if tbl = 'payroll_settings' then
      execute 'revoke delete on public.payroll_settings from authenticated';
    end if;

    execute format('drop policy if exists %I on public.%I', tbl || '_write', tbl);
    execute format(
      'create policy %I on public.%I for all to authenticated '
      'using (app.can(%L)) with check (app.can(%L))',
      tbl || '_write', tbl, write_perm, write_perm);
  end loop;
end $do$;

-- ===========================================================================
-- The lists the screens read
-- ===========================================================================
-- Every one of these is `security_invoker = on`, set explicitly after the
-- CREATE. `create or replace view` DISCARDS reloptions, so a view replaced in
-- a later migration silently loses it and starts reading with the owner's
-- rights — which is an RLS bypass that produces no error and no symptom.

create or replace view public.v_employees as
select e.id, e.full_name, e.job_title, e.phone, e.email,
       e.user_id,
       -- Computed from the column on this table rather than from the join
       -- below: `staff` is gated by `staff.read`, which somebody running
       -- payroll may not hold, and "has no login" is the wrong answer to give
       -- them when the truth is "you cannot see the staff list".
       (e.user_id is not null)                   as has_login,
       e.base_salary, e.wallet_id, w.name        as wallet_name,
       e.hired_on, e.ended_on, e.is_active, e.note,
       e.created_at, e.updated_at,
       r.name                                    as role_name,
       r.name_en                                 as role_name_en,
       coalesce(p.payslips, 0)                   as payslips,
       coalesce(p.paid_count, 0)                 as paid_count,
       coalesce(p.paid_total, 0)::numeric(14,2)  as paid_total,
       p.last_paid_at
  from public.employees e
  left join public.wallets w on w.id = e.wallet_id
  left join public.staff s   on s.user_id = e.user_id
  left join public.roles r   on r.id = s.role_id
  left join lateral (
    select count(*)                                            as payslips,
           count(*) filter (where ps.paid_at is not null)       as paid_count,
           sum(ps.net_amount) filter (where ps.paid_at is not null) as paid_total,
           max(ps.paid_at)                                      as last_paid_at
      from public.payslips ps where ps.employee_id = e.id
  ) p on true;

alter view public.v_employees set (security_invoker = on);

create or replace view public.v_salary_components as
select c.id, c.code, c.name, c.name_en, c.direction, c.is_system, c.is_active,
       c.sort_order, c.created_at, c.updated_at,
       coalesce(u.lines, 0)                as lines,
       coalesce(u.total, 0)::numeric(14,2) as total
  from public.salary_components c
  left join lateral (
    select count(*) as lines, sum(i.amount) as total
      from public.payslip_items i where i.component_id = c.id
  ) u on true;

alter view public.v_salary_components set (security_invoker = on);

create or replace view public.v_payroll_periods as
select p.id, p.period_month, p.status, p.note,
       p.approved_at, p.approved_by, p.closed_at, p.created_at, p.updated_at,
       coalesce(s.slips, 0)                     as slips,
       coalesce(s.paid_count, 0)                as paid_count,
       coalesce(s.gross_total, 0)::numeric(14,2) as gross_total,
       coalesce(s.net_total, 0)::numeric(14,2)   as net_total,
       coalesce(s.paid_total, 0)::numeric(14,2)  as paid_total
  from public.payroll_periods p
  left join lateral (
    select count(*)                                           as slips,
           count(*) filter (where ps.paid_at is not null)      as paid_count,
           sum(ps.gross_amount)                                as gross_total,
           sum(ps.net_amount)                                  as net_total,
           sum(ps.net_amount) filter (where ps.paid_at is not null) as paid_total
      from public.payslips ps where ps.period_id = p.id
  ) s on true;

alter view public.v_payroll_periods set (security_invoker = on);

/**
 * One payslip, with everything a screen or a document needs.
 *
 * `commissions_total` and `bonus_total` are split out because the thank-you
 * message names them separately, and they are defined so the arithmetic in
 * that message adds up exactly:
 *
 *     base + commissions + bonus − deductions = net
 *
 * so `bonus_total` is every earning that is NOT a commission, not just the
 * lines filed under the component called "حافز". A message whose numbers do
 * not add up is worse than one that omits them.
 */
create or replace view public.v_payslips as
select ps.id, ps.period_id, pp.period_month, pp.status as period_status,
       ps.employee_id, ps.employee_name, ps.job_title, ps.phone,
       e.is_active as employee_active,
       ps.base_salary, ps.earnings_total, ps.deductions_total,
       ps.gross_amount, ps.net_amount,
       coalesce(x.commissions, 0)::numeric(14,2)                      as commissions_total,
       (ps.earnings_total - coalesce(x.commissions, 0))::numeric(14,2) as bonus_total,
       ps.note, ps.paid_at, ps.paid_wallet_id, w.name as paid_wallet_name,
       ps.ledger_entry_id, ps.message_sent_at,
       ps.created_at, ps.updated_at,
       coalesce(it.items, '[]'::jsonb) as items
  from public.payslips ps
  join public.payroll_periods pp on pp.id = ps.period_id
  left join public.employees e   on e.id = ps.employee_id
  left join public.wallets w     on w.id = ps.paid_wallet_id
  left join lateral (
    select sum(i.amount) filter (where i.direction = 'earning' and c.code = 'commission')
             as commissions
      from public.payslip_items i
      join public.salary_components c on c.id = i.component_id
     where i.payslip_id = ps.id
  ) x on true
  left join lateral (
    select jsonb_agg(jsonb_build_object(
             'id', i.id,
             'component_id', i.component_id,
             'code', c.code,
             'label', coalesce(i.label, c.name),
             'component_name', c.name,
             'component_name_en', c.name_en,
             'direction', i.direction,
             'amount', i.amount)
             -- Earnings first, then deductions. Ordering by the column
             -- itself sorts 'deduction' before 'earning', which reads as a
             -- payslip that opens by taking things away.
             order by (i.direction = 'deduction'), c.sort_order, i.created_at) as items
      from public.payslip_items i
      join public.salary_components c on c.id = i.component_id
     where i.payslip_id = ps.id
  ) it on true;

alter view public.v_payslips set (security_invoker = on);

do $$
declare t text;
begin
  foreach t in array array[
    'v_employees', 'v_salary_components', 'v_payroll_periods', 'v_payslips'
  ] loop
    execute format('revoke all on public.%I from anon', t);
    execute format('grant select on public.%I to authenticated', t);
  end loop;
end $$;

-- ===========================================================================
-- Assertions
-- ===========================================================================
do $$
declare
  n       int;
  missing text;
begin
  -- Every view in this database reads with the caller's rights. This is the
  -- rule that is easiest to break by accident and hardest to notice.
  select count(*) into n
    from pg_class c
    join pg_namespace ns on ns.oid = c.relnamespace
   where ns.nspname = 'public' and c.relkind = 'v'
     and not coalesce(
       (select option_value from pg_options_to_table(c.reloptions)
         where option_name = 'security_invoker')::boolean, false);
  if n > 0 then
    select string_agg(c.relname, ', ') into missing
      from pg_class c join pg_namespace ns on ns.oid = c.relnamespace
     where ns.nspname = 'public' and c.relkind = 'v'
       and not coalesce(
         (select option_value from pg_options_to_table(c.reloptions)
           where option_name = 'security_invoker')::boolean, false);
    raise exception 'views without security_invoker: %', missing;
  end if;

  -- A table with RLS on and no policy denies everything, which is safe and is
  -- also how a table quietly disappears from the app.
  select string_agg(c.relname, ', ') into missing
    from pg_class c join pg_namespace ns on ns.oid = c.relnamespace
   where ns.nspname = 'public' and c.relkind = 'r' and c.relrowsecurity
     and not exists (select 1 from pg_policies p
                      where p.schemaname = 'public' and p.tablename = c.relname);
  if missing is not null then
    raise exception 'tables with RLS and no policy: %', missing;
  end if;
end $$;
