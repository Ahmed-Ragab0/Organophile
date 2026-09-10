-- A payroll cycle could never finish if anybody in it was owed nothing.
--
-- Found by the payroll suite the moment the database had a second employee in
-- it: somebody put on the roster from the Staff screen starts with a base of
-- zero, because being on the roster is about doing work and pay is a separate
-- decision (0053). Their payslip is generated correctly, its net is zero, and
-- `pay_payslip` rightly refuses to write a zero-pound expense to the ledger.
--
-- So the cycle sat at "1 of 2 paid" for ever. Every salary that was owed had
-- been paid, and the cycle still would not close, and nothing on screen could
-- explain why.
--
-- A cycle is waiting for MONEY, not for rows. A payslip with nothing to pay is
-- already finished with.

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

  perform set_config('app.payroll_paying', 'on', true);

  update public.payslips
     set paid_at         = v_when,
         paid_wallet_id  = v_wallet,
         ledger_entry_id = v_entry,
         updated_at      = now()
   where id = v_slip.id;

  /*
   * Is anybody still OWED something?
   *
   * `net_amount > 0` is the whole change. Counting unpaid rows instead left a
   * cycle open for ever over somebody owed nothing — and a cycle that cannot
   * reach "done" makes the whole flow it sits in meaningless.
   */
  select count(*) into v_left
    from public.payslips
   where period_id = v_slip.period_id and paid_at is null and net_amount > 0;
  if v_left = 0 then
    update public.payroll_periods set status = 'closed' where id = v_slip.period_id;
  end if;

  perform set_config('app.payroll_paying', 'off', true);

  return jsonb_build_object(
    'ok', true, 'ledger_entry_id', v_entry,
    'amount', v_slip.net_amount, 'wallet_id', v_wallet, 'paid_at', v_when);
end;
$function$;

-- The guard has to agree, or closing by hand would be refused for the same
-- reason closing automatically was skipped.
create or replace function app.guard_payroll_period()
returns trigger language plpgsql security definer set search_path = '' as $function$
declare
  v_paid  int;
  v_total int;
  v_owed  int;
begin
  if tg_op = 'DELETE' then
    if exists (select 1 from public.payslips
                where period_id = old.id and paid_at is not null) then
      raise exception 'a cycle with salaries already paid cannot be deleted'
        using errcode = 'restrict_violation';
    end if;
    return old;
  end if;

  new.period_month := date_trunc('month', new.period_month)::date;

  if tg_op = 'INSERT' then
    new.status := coalesce(new.status, 'draft');
    return new;
  end if;

  select count(*) filter (where paid_at is not null),
         count(*),
         count(*) filter (where paid_at is null and net_amount > 0)
    into v_paid, v_total, v_owed
    from public.payslips where period_id = new.id;

  if new.period_month is distinct from old.period_month and v_total > 0 then
    raise exception 'the month cannot change once the cycle has payslips'
      using errcode = 'restrict_violation';
  end if;

  if v_paid > 0 and new.status in ('draft', 'review') then
    raise exception 'salaries in this cycle are already paid'
      using errcode = 'restrict_violation';
  end if;

  -- Owed, not merely unpaid. Somebody on the roster with no salary set is not
  -- a reason to hold the month open.
  if new.status = 'closed' and v_owed > 0 then
    raise exception 'the cycle cannot close while a salary is unpaid'
      using errcode = 'restrict_violation';
  end if;

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

do $$ begin perform app.assert_guards_can_run(); end $$;
