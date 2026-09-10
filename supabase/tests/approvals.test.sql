-- approvals.test.sql
--
-- Regression suite for the spend-authorisation cycle: money leaving the
-- business goes past somebody who may authorise it, and approving IS the
-- spending rather than a signature somebody acts on later.
--
--   psql "$DATABASE_URL" -f supabase/tests/approvals.test.sql
--
-- One transaction, rolled back at the end. The second staff account is
-- temporarily demoted to accountant so the two sides of the cycle are two
-- genuinely different people — a suite that plays both parts as the owner
-- tests nothing.

begin;

select app.assert_guards_can_run();

do $$
declare
  v_owner  uuid;
  v_asker  uuid;
  v_role   uuid;
  v_wallet uuid;
  v_cat    uuid;
  v_emp    uuid;
  v_period uuid;
  v_slip   uuid;
  v_bonus  uuid;
  v_req    uuid;
  r        jsonb;
  v_b0 numeric; v_b1 numeric;
  v_failed boolean;
  n int;
begin
  select s.user_id into v_owner
    from public.staff s join public.roles r2 on r2.id = s.role_id
   where s.is_active and r2.is_superuser order by s.email limit 1;
  select s.user_id into v_asker from public.staff s where s.user_id <> v_owner limit 1;
  assert v_asker is not null,
    'A0: this suite needs a second staff account to be the one who asks';

  select id into v_wallet from public.wallets where is_active order by sort_order limit 1;
  select id into v_cat from public.expense_categories where is_active limit 1;
  select id into v_role from public.roles where code = 'accountant';
  select id into v_bonus from public.salary_components where code = 'bonus';

  perform set_config('request.jwt.claims',
    json_build_object('sub', v_owner, 'role', 'authenticated')::text, true);
  update public.staff set role_id = v_role where user_id = v_asker;

  ------------------------------------------------------------------ an expense
  perform set_config('request.jwt.claims',
    json_build_object('sub', v_asker, 'role', 'authenticated')::text, true);

  assert not app.may_authorise_spending(),
    'A1: the accountant can authorise their own spending';

  select balance into v_b0 from public.v_wallet_balances where id = v_wallet;
  r := public.add_expense('TSTA إيجار', null, 1500, v_wallet, now(), 'ملاحظة', v_cat);
  v_req := (r ->> 'request_id')::uuid;
  select balance into v_b1 from public.v_wallet_balances where id = v_wallet;

  assert (r ->> 'pending')::boolean, 'A2: the expense was not turned into a request';
  assert v_b1 = v_b0, format('A3: the wallet moved %s before anybody agreed', v_b1 - v_b0);
  assert (select amount from public.spend_requests where id = v_req) = 1500,
    'A4: the request does not carry what was asked for';

  -- A5: the decision columns are not a thing a client writes. Without this the
  -- whole feature is theatre: mark it approved, no money moves, nobody checks.
  v_failed := false;
  begin update public.spend_requests set status = 'approved' where id = v_req;
  exception when others then v_failed := true; end;
  assert v_failed, 'A5: a request was approved with a plain UPDATE';

  -- A6: ...and neither is the amount, once it has been asked for
  v_failed := false;
  begin update public.spend_requests set amount = 5 where id = v_req;
  exception when others then v_failed := true; end;
  assert v_failed, 'A6: the amount changed after the request was raised';

  -- A7: the asker cannot decide it
  v_failed := false;
  begin r := public.decide_spend_request(v_req, true, null);
  exception when others then v_failed := true; end;
  assert v_failed, 'A7: the accountant decided their own request';

  ------------------------------------------------------------------- the owner
  perform set_config('request.jwt.claims',
    json_build_object('sub', v_owner, 'role', 'authenticated')::text, true);

  assert app.may_authorise_spending(), 'A8: the owner cannot authorise spending';

  select balance into v_b0 from public.v_wallet_balances where id = v_wallet;
  r := public.decide_spend_request(v_req, true, 'ماشي');
  select balance into v_b1 from public.v_wallet_balances where id = v_wallet;

  assert (r ->> 'status') = 'approved', 'A9: approving failed: ' || r::text;
  -- A10: approving IS the spending. Not a flag somebody acts on afterwards.
  assert v_b1 - v_b0 = -1500,
    format('A10: the wallet moved %s on approval, expected -1500', v_b1 - v_b0);
  assert (select result_entry_id from public.spend_requests where id = v_req) is not null,
    'A11: an approved request does not point at what it produced';

  -- A12: the books say who asked as well as who agreed
  assert (select metadata ->> 'requested_by' from public.ledger_entries
           where id = (r ->> 'ledger_entry_id')::uuid) = v_asker::text,
    'A12: the ledger row does not name who asked';

  -- A13: decided once
  r := public.decide_spend_request(v_req, true, null);
  assert (r ->> 'reason') = 'already_decided', 'A13: a decided request was re-decided';

  -- A14: the owner's own spending is untouched by any of this
  select balance into v_b0 from public.v_wallet_balances where id = v_wallet;
  r := public.add_expense('TSTA مصروف المالك', null, 200, v_wallet, now(), null, v_cat);
  select balance into v_b1 from public.v_wallet_balances where id = v_wallet;
  assert not coalesce((r ->> 'pending')::boolean, false),
    'A14: the owner was made to ask permission';
  assert v_b1 - v_b0 = -200, 'A14b: the owner''s expense did not move the money';

  -------------------------------------------------------------------- a salary
  insert into public.employees (full_name, base_salary, wallet_id)
  values ('TSTA راتب', 4000, v_wallet) returning id into v_emp;
  r := public.open_payroll_period('2019-07-10');
  v_period := (r ->> 'id')::uuid;
  select id into v_slip from public.payslips
   where period_id = v_period and employee_id = v_emp;
  update public.payroll_periods set status = 'review'   where id = v_period;
  update public.payroll_periods set status = 'approved' where id = v_period;

  perform set_config('request.jwt.claims',
    json_build_object('sub', v_asker, 'role', 'authenticated')::text, true);

  select balance into v_b0 from public.v_wallet_balances where id = v_wallet;
  r := public.pay_payslip(v_slip, v_wallet, now(), 'مرتب يوليو');
  v_req := (r ->> 'request_id')::uuid;
  select balance into v_b1 from public.v_wallet_balances where id = v_wallet;

  assert (r ->> 'pending')::boolean, 'A15: paying a salary skipped the request';
  assert v_b1 = v_b0, 'A16: the wallet moved before the salary was approved';
  assert (select paid_at from public.payslips where id = v_slip) is null,
    'A17: the payslip says paid without anybody agreeing';

  -- A18: one live request per payslip, or it gets paid twice
  r := public.pay_payslip(v_slip, v_wallet, now(), null);
  assert (r ->> 'reason') = 'already_requested', 'A18: a second request was raised';

  /*
   * A19/A20: the figure cannot move under the approver.
   *
   * They agreed to an amount. If the payslip could be edited while the request
   * was live, a different amount would leave the wallet under the same
   * approval — the one way this feature could be made meaningless.
   */
  v_failed := false;
  begin update public.payslips set base_salary = 9000 where id = v_slip;
  exception when others then v_failed := true; end;
  assert v_failed, 'A19: a payslip was edited while waiting for approval';

  v_failed := false;
  begin insert into public.payslip_items (payslip_id, component_id, amount)
        values (v_slip, v_bonus, 500);
  exception when others then v_failed := true; end;
  assert v_failed, 'A20: a bonus was added while waiting for approval';

  perform set_config('request.jwt.claims',
    json_build_object('sub', v_owner, 'role', 'authenticated')::text, true);

  select balance into v_b0 from public.v_wallet_balances where id = v_wallet;
  r := public.decide_spend_request(v_req, true, 'تمام');
  select balance into v_b1 from public.v_wallet_balances where id = v_wallet;

  assert (r ->> 'status') = 'approved', 'A21: approving the salary failed: ' || r::text;
  assert v_b1 - v_b0 = -4000, format('A22: the wallet moved %s, expected -4000', v_b1 - v_b0);
  assert (select paid_at from public.payslips where id = v_slip) is not null,
    'A23: the payslip was not marked paid';
  assert (select status from public.payroll_periods where id = v_period) = 'closed',
    'A24: the cycle did not close after its last salary';

  --------------------------------------------------------- refusing and taking back
  perform set_config('request.jwt.claims',
    json_build_object('sub', v_asker, 'role', 'authenticated')::text, true);
  r := public.add_expense('TSTA مرفوض', null, 300, v_wallet, now(), null, v_cat);
  v_req := (r ->> 'request_id')::uuid;

  perform set_config('request.jwt.claims',
    json_build_object('sub', v_owner, 'role', 'authenticated')::text, true);
  select balance into v_b0 from public.v_wallet_balances where id = v_wallet;
  r := public.decide_spend_request(v_req, false, 'مش دلوقتي');
  select balance into v_b1 from public.v_wallet_balances where id = v_wallet;
  assert (r ->> 'status') = 'rejected', 'A25: rejecting failed: ' || r::text;
  assert v_b1 = v_b0, 'A26: a rejected request still moved money';
  assert (select result_entry_id from public.spend_requests where id = v_req) is null,
    'A27: a rejected request produced a ledger entry';

  perform set_config('request.jwt.claims',
    json_build_object('sub', v_asker, 'role', 'authenticated')::text, true);
  r := public.add_expense('TSTA هيتلغي', null, 50, v_wallet, now(), null, v_cat);
  r := public.cancel_spend_request((r ->> 'request_id')::uuid);
  assert (r ->> 'status') = 'cancelled', 'A28: the asker could not withdraw their own request';

  ------------------------------------------------------------------ visibility
  set local role authenticated;
  select count(*) into n from public.v_spend_requests;
  assert n >= 4, 'A29: the asker cannot see their own requests (' || n || ')';
  select count(*) into n from public.v_spend_requests where not is_mine;
  assert n = 0, 'A30: the asker can see somebody else''s requests';
  reset role;

  raise notice 'ALL APPROVAL TESTS PASSED';
end $$;

rollback;
