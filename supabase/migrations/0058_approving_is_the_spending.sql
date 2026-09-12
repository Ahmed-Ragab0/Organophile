-- Part two: the verbs.
--
-- The rule that makes this trustworthy is that approving does not *authorise*
-- the spend for somebody to perform later — approving IS the spend. The
-- decision and the ledger entry are one transaction, so a request marked
-- approved always has money behind it, and nobody has to remember a second
-- step.

-- ---------------------------------------------------------------------------
-- May I spend, or must I ask?
-- ---------------------------------------------------------------------------
create or replace function app.may_authorise_spending()
returns boolean language sql stable set search_path = '' as $$
  select app.can('approvals.write')
$$;

comment on function app.may_authorise_spending is
  'Whether the caller''s own spending moves money directly. The same authority '
  'as deciding somebody else''s request, on purpose: approving a spend you are '
  'not trusted to make yourself is not a distinction worth having.';

grant execute on function app.may_authorise_spending() to authenticated;

-- ---------------------------------------------------------------------------
-- Spending an expense
-- ---------------------------------------------------------------------------
-- Dropped rather than replaced: the return type changes from uuid to jsonb,
-- because the caller now has to be told WHICH of the two things happened. A
-- bare id could not say "nothing moved, somebody has to agree first".
drop function if exists public.add_expense(text, text, numeric, uuid, timestamptz, text, uuid);

create or replace function public.add_expense(
  p_description text,
  p_category    text,
  p_amount      numeric,
  p_wallet_id   uuid,
  p_occurred_at timestamptz default now(),
  p_notes       text default null,
  p_category_id uuid default null
) returns jsonb
language plpgsql security definer set search_path = '' as $function$
declare
  v_id       uuid;
  v_cat_id   uuid := p_category_id;
  v_cat_name text;
  v_when     timestamptz := coalesce(p_occurred_at, now());
begin
  if not app.can('money.write') then raise exception 'forbidden'; end if;
  if p_amount is null or p_amount <= 0 then
    raise exception 'amount must be greater than zero';
  end if;
  if nullif(btrim(coalesce(p_description,'')),'') is null then
    raise exception 'description is required';
  end if;

  perform app.require_wallet(p_wallet_id);

  -- An id wins over a name, because the id is the one that survives a rename.
  if v_cat_id is not null then
    select name into v_cat_name from public.expense_categories where id = v_cat_id;
    if v_cat_name is null then raise exception 'unknown expense category'; end if;
  else
    v_cat_name := nullif(btrim(coalesce(p_category, '')), '');
    if v_cat_name is null then raise exception 'category is required'; end if;
    v_cat_id := app.resolve_expense_category(v_cat_name);
    select name into v_cat_name from public.expense_categories where id = v_cat_id;
  end if;

  /*
   * The fork, and the only one.
   *
   * Somebody who may authorise spending spends. Everybody else asks, with the
   * same call and the same arguments — the front end does not choose, and
   * cannot, because it has never been able to write to `ledger_entries` at all.
   */
  if not app.may_authorise_spending() then
    perform set_config('app.spend_deciding', 'on', true);
    insert into public.spend_requests (
      kind, amount, wallet_id, occurred_at, description, note,
      category_id, requested_by
    ) values (
      'expense', p_amount, p_wallet_id, v_when, btrim(p_description),
      nullif(btrim(coalesce(p_notes, '')), ''), v_cat_id, auth.uid()
    ) returning id into v_id;
    perform set_config('app.spend_deciding', 'off', true);

    return jsonb_build_object('ok', true, 'pending', true, 'request_id', v_id);
  end if;

  insert into public.ledger_entries (
    entry_type, wallet_id, amount, occurred_at, description, category, category_id,
    metadata, created_by
  ) values (
    'expense', p_wallet_id, p_amount, v_when,
    btrim(p_description), v_cat_name, v_cat_id,
    jsonb_build_object('notes', p_notes), auth.uid()
  )
  returning id into v_id;

  return jsonb_build_object('ok', true, 'pending', false, 'entry_id', v_id);
end;
$function$;

revoke all on function public.add_expense(text, text, numeric, uuid, timestamptz, text, uuid)
  from public, anon;
grant execute on function public.add_expense(text, text, numeric, uuid, timestamptz, text, uuid)
  to authenticated;

-- ---------------------------------------------------------------------------
-- Paying a salary
-- ---------------------------------------------------------------------------
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
  v_request  uuid;
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

  -- Ask, if asking is what this person does.
  if not app.may_authorise_spending() then
    if app.payslip_has_live_request(v_slip.id) then
      return jsonb_build_object('ok', false, 'reason', 'already_requested');
    end if;

    perform set_config('app.spend_deciding', 'on', true);
    insert into public.spend_requests (
      kind, amount, wallet_id, occurred_at, description, note,
      payslip_id, requested_by
    ) values (
      'payslip', v_slip.net_amount, v_wallet, v_when,
      'مرتب ' || v_slip.employee_name || ' — '
        || app.arabic_month(v_month) || ' ' || to_char(v_month, 'YYYY'),
      nullif(btrim(coalesce(p_note, '')), ''), v_slip.id, auth.uid()
    ) returning id into v_request;
    perform set_config('app.spend_deciding', 'off', true);

    return jsonb_build_object('ok', true, 'pending', true, 'request_id', v_request);
  end if;

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

  select count(*) into v_left
    from public.payslips
   where period_id = v_slip.period_id and paid_at is null and net_amount > 0;
  if v_left = 0 then
    update public.payroll_periods set status = 'closed' where id = v_slip.period_id;
  end if;

  perform set_config('app.payroll_paying', 'off', true);

  return jsonb_build_object(
    'ok', true, 'pending', false, 'ledger_entry_id', v_entry,
    'amount', v_slip.net_amount, 'wallet_id', v_wallet, 'paid_at', v_when);
end;
$function$;

-- ---------------------------------------------------------------------------
-- Deciding
-- ---------------------------------------------------------------------------
/**
 * Approve or refuse a request — and, on approval, spend it.
 *
 * `pay_payslip` is called back into rather than duplicated: the approver holds
 * `approvals.write`, so the fork above sends it straight down the paying
 * branch, and every rule that guards a salary payment applies exactly once and
 * in one place.
 */
create or replace function public.decide_spend_request(
  p_request_id uuid,
  p_approve    boolean,
  p_note       text default null
) returns jsonb
language plpgsql security definer set search_path = '' as $function$
declare
  r          public.spend_requests;
  v_entry    uuid;
  v_cat_name text;
  v_result   jsonb;
  v_net      numeric;
begin
  if not app.can('approvals.write') then raise exception 'forbidden'; end if;

  select * into r from public.spend_requests where id = p_request_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'not_found');
  end if;
  if r.status <> 'pending' then
    return jsonb_build_object('ok', false, 'reason', 'already_decided', 'status', r.status);
  end if;

  /*
   * Nobody signs off their own spending.
   *
   * Somebody who may authorise spending never raises a request, so this only
   * bites when a person was promoted while one of theirs was outstanding —
   * and in that case the honest answer is that a second pair of eyes is
   * exactly what the request was for. They can cancel it and spend directly.
   */
  if r.requested_by = auth.uid() then
    return jsonb_build_object('ok', false, 'reason', 'own_request');
  end if;

  if not p_approve then
    perform set_config('app.spend_deciding', 'on', true);
    update public.spend_requests
       set status = 'rejected', decided_by = auth.uid(), decided_at = now(),
           decision_note = nullif(btrim(coalesce(p_note, '')), ''), updated_at = now()
     where id = r.id;
    perform set_config('app.spend_deciding', 'off', true);
    return jsonb_build_object('ok', true, 'status', 'rejected');
  end if;

  perform app.require_wallet(r.wallet_id);

  if r.kind = 'payslip' then
    -- The amount agreed to must still be the amount owed. A payslip cannot be
    -- edited while a request is live, so this should never fire — which is
    -- exactly why it is checked rather than assumed.
    select net_amount into v_net from public.payslips where id = r.payslip_id;
    if v_net is distinct from r.amount then
      return jsonb_build_object('ok', false, 'reason', 'amount_changed',
                                'requested', r.amount, 'now', v_net);
    end if;

    v_result := public.pay_payslip(r.payslip_id, r.wallet_id, r.occurred_at, r.note);
    if not coalesce((v_result ->> 'ok')::boolean, false) then
      return jsonb_build_object('ok', false, 'reason', v_result ->> 'reason',
                                'from_payment', v_result);
    end if;
    v_entry := (v_result ->> 'ledger_entry_id')::uuid;
  else
    select name into v_cat_name from public.expense_categories where id = r.category_id;
    insert into public.ledger_entries (
      entry_type, wallet_id, amount, occurred_at, description, category, category_id,
      metadata, created_by
    ) values (
      'expense', r.wallet_id, r.amount, r.occurred_at, r.description,
      v_cat_name, r.category_id,
      jsonb_build_object(
        'notes', r.note,
        -- The books say who asked as well as who agreed. A ledger row that can
        -- only be explained by opening another screen is a row that gets
        -- misread.
        'spend_request_id', r.id,
        'requested_by', r.requested_by,
        'approved_by', auth.uid()),
      auth.uid()
    ) returning id into v_entry;
  end if;

  perform set_config('app.spend_deciding', 'on', true);
  update public.spend_requests
     set status = 'approved', decided_by = auth.uid(), decided_at = now(),
         decision_note = nullif(btrim(coalesce(p_note, '')), ''),
         result_entry_id = v_entry, updated_at = now()
   where id = r.id;
  perform set_config('app.spend_deciding', 'off', true);

  return jsonb_build_object('ok', true, 'status', 'approved', 'ledger_entry_id', v_entry);
end;
$function$;

/** Take back a request you raised, while nobody has answered it. */
create or replace function public.cancel_spend_request(p_request_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $function$
declare r public.spend_requests;
begin
  select * into r from public.spend_requests where id = p_request_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'not_found');
  end if;
  if r.status <> 'pending' then
    return jsonb_build_object('ok', false, 'reason', 'already_decided', 'status', r.status);
  end if;
  if r.requested_by is distinct from auth.uid() and not app.can('approvals.write') then
    return jsonb_build_object('ok', false, 'reason', 'not_yours');
  end if;

  perform set_config('app.spend_deciding', 'on', true);
  update public.spend_requests
     set status = 'cancelled', updated_at = now() where id = r.id;
  perform set_config('app.spend_deciding', 'off', true);

  return jsonb_build_object('ok', true, 'status', 'cancelled');
end;
$function$;

do $$
declare f text;
begin
  foreach f in array array[
    'public.decide_spend_request(uuid, boolean, text)',
    'public.cancel_spend_request(uuid)'
  ] loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- A payslip with somebody waiting on it does not move
-- ---------------------------------------------------------------------------
create or replace function app.guard_payslip()
returns trigger language plpgsql security definer set search_path = '' as $function$
declare
  v_paying boolean := app.payroll_is_paying();
  v_status text;
begin
  if tg_op = 'DELETE' then
    if old.paid_at is not null then
      raise exception 'a paid payslip cannot be deleted, only reversed'
        using errcode = 'restrict_violation';
    end if;
    if app.payslip_has_live_request(old.id) then
      raise exception 'this payslip is waiting for approval'
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

  if not v_paying
     and (new.paid_at is distinct from old.paid_at
          or new.paid_wallet_id is distinct from old.paid_wallet_id
          or new.ledger_entry_id is distinct from old.ledger_entry_id) then
    raise exception 'a payslip is paid through pay_payslip, not by writing to it'
      using errcode = 'restrict_violation';
  end if;

  /*
   * Frozen while somebody is being asked to approve it.
   *
   * The approver agreed to a figure. If the payslip could be edited in the
   * meantime, a different figure would leave the wallet under the same
   * approval — which is the one way this whole feature could be turned into
   * theatre. `decide_spend_request` re-checks the amount as well; this stops
   * the situation arising at all.
   */
  if not v_paying and app.payslip_has_live_request(old.id)
     and (new.base_salary      is distinct from old.base_salary
       or new.earnings_total   is distinct from old.earnings_total
       or new.deductions_total is distinct from old.deductions_total
       or new.employee_id      is distinct from old.employee_id
       or new.period_id        is distinct from old.period_id) then
    raise exception 'this payslip is waiting for approval and cannot change'
      using errcode = 'restrict_violation';
  end if;

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

-- ...and neither do its lines.
create or replace function app.guard_payslip_item()
returns trigger language plpgsql security definer set search_path = '' as $function$
declare
  v_slip uuid := case when tg_op = 'DELETE' then old.payslip_id else new.payslip_id end;
  v_paid timestamptz;
  v_dir  text;
  v_name text;
begin
  select paid_at into v_paid from public.payslips where id = v_slip;
  if v_paid is not null then
    raise exception 'a paid payslip cannot be changed' using errcode = 'restrict_violation';
  end if;
  if app.payslip_has_live_request(v_slip) then
    raise exception 'this payslip is waiting for approval and cannot change'
      using errcode = 'restrict_violation';
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

do $$ begin perform app.assert_guards_can_run(); end $$;
