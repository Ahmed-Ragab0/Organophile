-- Payroll, part two: the money.
--
-- 0049 made a salary a document. This makes paying one a single act with a
-- single consequence in the books, and gives the reversal a door of its own.
--
-- The shape follows rule 8 exactly. `ledger_entries` has no write policy, so
-- a salary reaches the ledger the same way every other movement does — a
-- SECURITY DEFINER function that checks the caller, writes the entry, and
-- stamps the document in the SAME transaction. There is no window in which a
-- payslip says "paid" and the wallet disagrees.
--
-- Reversing is voiding, never deleting (rule 6). An expense recorded and then
-- reversed is a different fact from one that never happened, and only the
-- first can be explained to somebody in three months.

-- ---------------------------------------------------------------------------
-- The month, spelled the way the owner reads it
-- ---------------------------------------------------------------------------
-- Written out rather than `to_char(d, 'TMMonth')`, which depends on the
-- server's lc_time. A ledger description that changes wording when a database
-- setting changes is not a description.
create or replace function app.arabic_month(p_date date)
returns text language sql immutable set search_path = '' as $$
  select case extract(month from p_date)::int
    when  1 then 'يناير'   when  2 then 'فبراير' when  3 then 'مارس'
    when  4 then 'أبريل'   when  5 then 'مايو'   when  6 then 'يونيو'
    when  7 then 'يوليو'   when  8 then 'أغسطس'  when  9 then 'سبتمبر'
    when 10 then 'أكتوبر'  when 11 then 'نوفمبر' when 12 then 'ديسمبر'
  end
$$;

-- ---------------------------------------------------------------------------
-- Opening a cycle
-- ---------------------------------------------------------------------------
create or replace function public.generate_payslips(p_period_id uuid)
returns int language plpgsql security definer set search_path = '' as $function$
declare
  v_status text;
  v_month  date;
  v_n      int;
begin
  if not app.can('payroll.write') then raise exception 'forbidden'; end if;

  select status, period_month into v_status, v_month
    from public.payroll_periods where id = p_period_id;
  if not found then raise exception 'no such payroll cycle'; end if;
  if v_status not in ('draft', 'review') then
    raise exception 'this cycle is approved; reopen it before adding anybody'
      using errcode = 'restrict_violation';
  end if;

  /*
   * Everyone active who was actually employed during this month.
   *
   * The two date tests are the difference between a payroll run and a list of
   * names: somebody who left in July must not appear on September's, and
   * somebody starting in October must not appear on September's either. An
   * employee with no dates recorded is assumed to be here, which is the
   * common case and the safe one — they show up and can be removed.
   */
  insert into public.payslips (
    period_id, employee_id, employee_name, job_title, phone, base_salary)
  select p_period_id, e.id, e.full_name, e.job_title, e.phone, e.base_salary
    from public.employees e
   where e.is_active
     and (e.hired_on is null or e.hired_on < (v_month + interval '1 month')::date)
     and (e.ended_on is null or e.ended_on >= v_month)
     and not exists (
       select 1 from public.payslips ps
        where ps.period_id = p_period_id and ps.employee_id = e.id);

  get diagnostics v_n = row_count;
  return v_n;
end;
$function$;

comment on function public.generate_payslips is
  'Adds a draft payslip for everybody employed during the cycle''s month who '
  'does not have one yet. Safe to run twice.';

create or replace function public.open_payroll_period(p_month date default null)
returns jsonb language plpgsql security definer set search_path = '' as $function$
declare
  v_month  date;
  v_id     uuid;
  v_status text;
  v_added  int;
begin
  if not app.can('payroll.write') then raise exception 'forbidden'; end if;

  -- Cairo, like every other date in this system. On the first of the month at
  -- 01:00 Cairo, UTC is still in the previous month.
  v_month := date_trunc('month',
    coalesce(p_month, (now() at time zone 'Africa/Cairo')::date))::date;

  insert into public.payroll_periods (period_month) values (v_month)
  on conflict (period_month) do update set period_month = excluded.period_month
  returning id into v_id;

  -- Re-opening an existing cycle picks up anybody hired since. One past
  -- review refuses to be filled, so the status is read rather than assumed —
  -- asking for this month twice must never be an error.
  select status into v_status from public.payroll_periods where id = v_id;
  v_added := case when v_status in ('draft', 'review')
                  then public.generate_payslips(v_id) else 0 end;

  return jsonb_build_object(
    'ok', true, 'id', v_id, 'period_month', v_month,
    'status', v_status, 'added', v_added);
end;
$function$;

comment on function public.open_payroll_period is
  'Opens (or finds) the cycle for a month and fills it with draft payslips. '
  'Defaults to the current month in Cairo.';

-- ---------------------------------------------------------------------------
-- Paying
-- ---------------------------------------------------------------------------
/**
 * Turn an approved payslip into money out of a wallet.
 *
 * Refusals that a person can act on come back as `{ok:false, reason:…}` so
 * the screen can say them in Arabic; only things that mean the caller has no
 * business here at all are raised. That is the same contract `delete_record`
 * uses, and the reason the payroll screen never shows a raw Postgres message.
 *
 * NOT checked here: whether the wallet has the balance. `transfer_between_
 * wallets` refuses an overdraft because both sides are inside this system and
 * a negative balance there is always an error. A salary leaves for the real
 * world, and a wallet that reads low because a cash top-up has not been
 * entered yet must not be able to stop payroll. The screen shows the balance
 * next to the choice instead.
 */
create or replace function public.pay_payslip(
  p_payslip_id  uuid,
  p_wallet_id   uuid default null,
  p_occurred_at timestamptz default null,
  p_note        text default null
) returns jsonb
language plpgsql security definer set search_path = '' as $function$
declare
  v_slip     public.payslips;
  v_status   text;
  v_month    date;
  v_wallet   uuid;
  v_cat_id   uuid;
  v_cat_name text;
  v_entry    uuid;
  v_when     timestamptz := coalesce(p_occurred_at, now());
  v_left     int;
begin
  if not app.can('payroll.write') then raise exception 'forbidden'; end if;

  select * into v_slip from public.payslips where id = p_payslip_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'not_found');
  end if;
  if v_slip.paid_at is not null then
    return jsonb_build_object('ok', false, 'reason', 'already_paid');
  end if;

  select status, period_month into v_status, v_month
    from public.payroll_periods where id = v_slip.period_id;
  if v_status <> 'approved' then
    return jsonb_build_object('ok', false, 'reason', 'not_approved', 'status', v_status);
  end if;

  if v_slip.net_amount <= 0 then
    return jsonb_build_object('ok', false, 'reason', 'nothing_to_pay');
  end if;

  -- The wallet asked for, else this person's usual one, else the payroll
  -- default. Three fallbacks so the ordinary case is one click and the
  -- unusual one is still expressible.
  v_wallet := coalesce(
    p_wallet_id,
    (select e.wallet_id from public.employees e where e.id = v_slip.employee_id),
    (select s.default_wallet_id from public.payroll_settings s limit 1));
  if v_wallet is null then
    return jsonb_build_object('ok', false, 'reason', 'no_wallet');
  end if;
  perform app.require_wallet(v_wallet);

  select s.expense_category_id into v_cat_id from public.payroll_settings s limit 1;
  if v_cat_id is null then
    v_cat_id := app.resolve_expense_category('مرتبات');
  end if;
  select name into v_cat_name from public.expense_categories where id = v_cat_id;

  /*
   * The whole payslip is copied into the entry's metadata, not just its id.
   *
   * The ledger is read on its own — in the expenses screen, in an export, in
   * a query six months from now — and a row that can only be understood by
   * joining back to another table is a row that will be misread. The id is
   * there for the link; the figures are there for the reader.
   */
  insert into public.ledger_entries (
    entry_type, wallet_id, amount, occurred_at, description, category, category_id,
    metadata, created_by
  ) values (
    'expense', v_wallet, v_slip.net_amount, v_when,
    'مرتب ' || v_slip.employee_name || ' — '
      || app.arabic_month(v_month) || ' ' || to_char(v_month, 'YYYY'),
    v_cat_name, v_cat_id,
    jsonb_build_object(
      'kind',          'payroll',
      'payslip_id',    v_slip.id,
      'employee_id',   v_slip.employee_id,
      'employee_name', v_slip.employee_name,
      'period_month',  to_char(v_month, 'YYYY-MM'),
      'base_salary',   v_slip.base_salary,
      'earnings',      v_slip.earnings_total,
      'deductions',    v_slip.deductions_total,
      'notes',         p_note),
    auth.uid()
  ) returning id into v_entry;

  -- The flag is how the guards in 0049 tell this write apart from a client
  -- writing `paid_at` directly, which would move no money at all.
  perform set_config('app.payroll_paying', 'on', true);

  update public.payslips
     set paid_at         = v_when,
         paid_wallet_id  = v_wallet,
         ledger_entry_id = v_entry,
         updated_at      = now()
   where id = v_slip.id;

  -- A cycle closes itself when the last person in it is paid. Nobody should
  -- have to remember to do that, and a cycle left open reads as unfinished.
  select count(*) into v_left
    from public.payslips where period_id = v_slip.period_id and paid_at is null;
  if v_left = 0 then
    update public.payroll_periods set status = 'closed' where id = v_slip.period_id;
  end if;

  perform set_config('app.payroll_paying', 'off', true);

  return jsonb_build_object(
    'ok', true, 'ledger_entry_id', v_entry,
    'amount', v_slip.net_amount, 'wallet_id', v_wallet, 'paid_at', v_when);
end;
$function$;

/**
 * Undo a payment.
 *
 * The ledger entry is voided, not deleted, and the payslip lets go of it —
 * the constraint says paid and entry are one fact, so it has to. The trail
 * survives in the direction that matters: the voided entry still carries the
 * payslip's id in its metadata, so "what was this reversal about" is always
 * answerable from the books.
 */
create or replace function public.unpay_payslip(
  p_payslip_id uuid,
  p_reason     text default null
) returns jsonb
language plpgsql security definer set search_path = '' as $function$
declare
  v_slip  public.payslips;
  v_entry uuid;
begin
  if not app.can('payroll.write') then raise exception 'forbidden'; end if;

  select * into v_slip from public.payslips where id = p_payslip_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'not_found');
  end if;
  if v_slip.paid_at is null then
    return jsonb_build_object('ok', false, 'reason', 'not_paid');
  end if;

  v_entry := v_slip.ledger_entry_id;
  perform set_config('app.payroll_paying', 'on', true);

  update public.ledger_entries
     set voided_at   = now(),
         voided_by   = auth.uid(),
         void_reason = coalesce(nullif(btrim(coalesce(p_reason, '')), ''),
                                'إلغاء صرف مرتب')
   where id = v_entry and voided_at is null;

  update public.payslips
     set paid_at = null, paid_wallet_id = null, ledger_entry_id = null,
         updated_at = now()
   where id = v_slip.id;

  -- The cycle has somebody unpaid in it again, so it is not closed any more.
  update public.payroll_periods
     set status = 'approved' where id = v_slip.period_id and status = 'closed';

  perform set_config('app.payroll_paying', 'off', true);

  return jsonb_build_object('ok', true, 'voided_entry_id', v_entry);
end;
$function$;

do $$
declare f text;
begin
  foreach f in array array[
    'public.generate_payslips(uuid)',
    'public.open_payroll_period(date)',
    'public.pay_payslip(uuid, uuid, timestamptz, text)',
    'public.unpay_payslip(uuid, text)'
  ] loop
    -- The default grant on a function is EXECUTE TO PUBLIC, and `anon` holds
    -- it by membership. Revoking from `anon` alone removes nothing — 0045 was
    -- written because that had been done four times already.
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end $$;

-- ===========================================================================
-- The record verbs learn two more families
-- ===========================================================================
create or replace function app.record_links_employee(p_id uuid)
returns table (
  is_found       boolean,
  label          text,
  archived       boolean,
  archivable     boolean,
  links          jsonb,
  money_count    bigint,
  money_amount   numeric,
  blocked_reason text
) language plpgsql stable security definer set search_path = '' as $function$
declare
  v_links jsonb := '[]'::jsonb;
  n       bigint;
begin
  is_found := false; archived := false; archivable := true;
  money_count := 0; money_amount := 0;

  select true, e.full_name, not e.is_active
    into is_found, label, archived
    from public.employees e where e.id = p_id;

  if not coalesce(is_found, false) then return next; return; end if;

  -- Salaries actually paid. This is the money test, and it is what makes an
  -- employee who has ever been paid permanent.
  select count(*), coalesce(sum(ps.net_amount), 0)
    into money_count, money_amount
    from public.payslips ps
   where ps.employee_id = p_id and ps.paid_at is not null;
  if money_count > 0 then
    v_links := v_links || jsonb_build_object(
      'what', 'payslips_paid', 'count', money_count, 'money', true);
  end if;

  select count(*) into n
    from public.payslips ps where ps.employee_id = p_id and ps.paid_at is null;
  if n > 0 then
    -- Unpaid drafts are not money, but they still point here, and the foreign
    -- key is RESTRICT. Saying so beats letting the delete fail with a
    -- constraint name.
    v_links := v_links || jsonb_build_object('what', 'payslips', 'count', n, 'money', false);
    blocked_reason := 'in_use';
  end if;

  links := v_links;
  return next;
end;
$function$;

create or replace function app.record_links_salary_component(p_id uuid)
returns table (
  is_found       boolean,
  label          text,
  archived       boolean,
  archivable     boolean,
  links          jsonb,
  money_count    bigint,
  money_amount   numeric,
  blocked_reason text
) language plpgsql stable security definer set search_path = '' as $function$
declare
  v_links  jsonb := '[]'::jsonb;
  v_system boolean := false;
  n        bigint;
begin
  is_found := false; archived := false; archivable := true;
  money_count := 0; money_amount := 0;

  select true, c.name, not c.is_active, c.is_system
    into is_found, label, archived, v_system
    from public.salary_components c where c.id = p_id;

  if not coalesce(is_found, false) then return next; return; end if;

  select count(*) into n from public.payslip_items i where i.component_id = p_id;
  if n > 0 then
    v_links := v_links || jsonb_build_object(
      'what', 'payslip_items', 'count', n, 'money', false);
    blocked_reason := 'in_use';
  end if;

  -- `commission` and `bonus` are read by name when the thank-you message is
  -- built. Renaming one is fine; removing it would leave the message
  -- computing a total from a component that no longer exists.
  if v_system then blocked_reason := 'system_record'; end if;

  links := v_links;
  return next;
end;
$function$;

create or replace function app.record_links_ext(p_kind text, p_id uuid)
returns table (
  is_found       boolean,
  label          text,
  archived       boolean,
  archivable     boolean,
  links          jsonb,
  money_count    bigint,
  money_amount   numeric,
  blocked_reason text
) language plpgsql stable security definer set search_path = '' as $function$
begin
  case p_kind
    when 'expense_category' then
      return query select * from app.record_links_expense_category(p_id);
    when 'plan_kind' then
      return query select * from app.record_links_plan_kind(p_id);
    when 'employee' then
      return query select * from app.record_links_employee(p_id);
    when 'salary_component' then
      return query select * from app.record_links_salary_component(p_id);
    else
      -- Unknown to this function. Returning no rows is the answer.
      return;
  end case;
end;
$function$;

create or replace function app.delete_record_ext(p_kind text, p_id uuid)
returns boolean language plpgsql security definer set search_path = '' as $function$
begin
  case p_kind
    when 'expense_category' then
      delete from public.expense_categories where id = p_id; return found;
    when 'plan_kind' then
      delete from public.plan_kinds where id = p_id; return found;
    when 'employee' then
      delete from public.employees where id = p_id; return found;
    when 'salary_component' then
      delete from public.salary_components where id = p_id; return found;
    else
      return null;    -- not a kind this function knows
  end case;
end;
$function$;

create or replace function app.archive_record_ext(
  p_kind text, p_id uuid, p_archived boolean
) returns boolean language plpgsql security definer set search_path = '' as $function$
begin
  case p_kind
    when 'expense_category' then
      update public.expense_categories
         set is_active = not p_archived, updated_at = now() where id = p_id;
      return found;
    when 'plan_kind' then
      update public.plan_kinds
         set is_active = not p_archived, updated_at = now() where id = p_id;
      return found;
    when 'employee' then
      -- The whole point of archiving here: somebody who has left keeps every
      -- payslip they were ever paid, and stops appearing in next month's run.
      update public.employees
         set is_active = not p_archived, updated_at = now() where id = p_id;
      return found;
    when 'salary_component' then
      update public.salary_components
         set is_active = not p_archived, updated_at = now() where id = p_id;
      return found;
    else
      return null;
  end case;
end;
$function$;

-- The permission each family answers to. Both of these are payroll: the
-- salary components are payroll vocabulary, read by the payroll screen and
-- nowhere else, and what somebody's deductions are called is as confidential
-- as what they earn.
create or replace function app.record_kind_permission(p_kind text, p_action text)
returns text language sql immutable set search_path = '' as $$
  select case p_kind
    when 'student'           then 'students'
    when 'course'            then 'courses'
    when 'package'           then 'courses'
    when 'university'        then 'courses'
    when 'track'             then 'courses'
    when 'subscription'      then 'subscriptions'
    when 'installment_plan'  then 'subscriptions'
    when 'wallet'            then 'money'
    when 'expense_category'  then 'settings'
    when 'plan_kind'         then 'settings'
    when 'employee'          then 'payroll'
    when 'salary_component'  then 'payroll'
    -- An unknown kind maps to the permission nothing but a superuser holds by
    -- name, so a family added without touching this function fails closed.
    else 'staff'
  end || '.' || case when p_action = 'write' then 'write' else 'read' end
$$;

grant execute on function app.record_kind_permission(text, text) to authenticated;

-- ===========================================================================
-- Assertions
-- ===========================================================================
do $$
declare
  v_bad text;
  v_n   int;
begin
  -- The three record verbs must not have drifted back open. 0045 closed them
  -- once; a `create or replace` of any of them keeps privileges, but a DROP +
  -- CREATE would not, and this is the migration most likely to do that next.
  select string_agg(p.proname, ', ') into v_bad
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname in ('describe_record', 'delete_record', 'archive_record',
                       'pay_payslip', 'unpay_payslip', 'open_payroll_period',
                       'generate_payslips')
     and has_function_privilege('anon', p.oid, 'execute');
  if v_bad is not null then
    raise exception 'anon can execute: %', v_bad;
  end if;

  -- Every family the dispatcher answers must be a family the permission map
  -- knows, or a delete would ask for `staff.write` and quietly never work.
  foreach v_bad in array array['employee', 'salary_component'] loop
    if app.record_kind_permission(v_bad, 'write') like 'staff.%' then
      raise exception 'record kind % has no permission of its own', v_bad;
    end if;
  end loop;

  -- 0047 rewrote every guard from app.is_admin() to app.can(). Nothing added
  -- since may reintroduce it.
  select count(*) into v_n
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname in ('public', 'app')
     and p.prosrc like '%is_admin()%'
     and p.proname <> 'is_admin';
  if v_n > 0 then
    raise exception '% function(s) still guard with app.is_admin()', v_n;
  end if;
end $$;
