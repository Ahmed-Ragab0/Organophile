-- payroll.test.sql
--
-- Regression suite for payroll: the document, the money, and the six rails
-- that stop a paid salary from quietly becoming a different fact.
--
--   psql "$DATABASE_URL" -f supabase/tests/payroll.test.sql
--
-- Everything happens inside one transaction that is rolled back at the end, so
-- this is safe to run against the live database — which is the point, because
-- the rails being tested are triggers and policies that only exist there.
--
-- The cycle is opened in a month far in the past (March 2019) so it cannot
-- collide with a real one even for the instant the transaction is open.

begin;

do $$
declare
  v_admin  uuid;
  v_wallet uuid;
  v_emp    uuid;
  v_period uuid;
  v_slip   uuid;
  v_entry  uuid;
  r        jsonb;
  n        int;
  v_earn   numeric; v_ded numeric; v_net numeric;
  v_before numeric; v_after numeric;
  c_comm   uuid; c_bonus uuid; c_ded uuid;
  v_failed boolean;
begin
  -- Run as somebody who actually holds payroll.write. `app.can` reads
  -- auth.uid(), which reads the JWT claims, so the test has to present some.
  select s.user_id into v_admin
    from public.staff s join public.roles r2 on r2.id = s.role_id
   where s.is_active and r2.is_superuser
   limit 1;
  assert v_admin is not null, 'P0: no active superuser to run the suite as';

  perform set_config('request.jwt.claims',
    json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  assert app.can('payroll.write'), 'P0b: the suite could not authenticate';

  select id into v_wallet from public.wallets where is_active order by sort_order limit 1;
  select id into c_comm  from public.salary_components where code = 'commission';
  select id into c_bonus from public.salary_components where code = 'bonus';
  select id into c_ded   from public.salary_components where code = 'penalty';
  assert c_comm is not null and c_bonus is not null,
    'P0c: the two system components must exist — the message reads them by name';

  ------------------------------------------------------------------ the shape
  insert into public.employees (full_name, job_title, phone, base_salary, wallet_id)
  values ('TSTEMP one', 'محاسب', '01012345678', 6000, v_wallet)
  returning id into v_emp;

  -- P1: created_by is stamped by trigger, not trusted from the client
  assert (select created_by from public.employees where id = v_emp) = v_admin,
    'P1: created_by was not stamped';

  -- P2: any day in the month opens that month's cycle
  r := public.open_payroll_period('2019-03-17'::date);
  v_period := (r ->> 'id')::uuid;
  assert (r ->> 'period_month') = '2019-03-01',
    'P2: the 17th did not normalise to the 1st: ' || (r ->> 'period_month');

  select id into v_slip from public.payslips
   where period_id = v_period and employee_id = v_emp;
  assert v_slip is not null, 'P3: the cycle did not pick up an active employee';

  -- P4: the payslip snapshots the person, so a later rename cannot rewrite it
  assert (select employee_name from public.payslips where id = v_slip) = 'TSTEMP one',
    'P4: the name was not snapshotted';
  update public.employees set full_name = 'TSTEMP renamed' where id = v_emp;
  assert (select employee_name from public.payslips where id = v_slip) = 'TSTEMP one',
    'P4b: renaming the employee rewrote a payslip';

  -- P5: filling twice adds nobody twice
  n := public.generate_payslips(v_period);
  assert n = 0, 'P5: generate_payslips is not idempotent, added ' || n;

  -- P6: somebody who left before the month is not in it
  insert into public.employees (full_name, base_salary, ended_on)
  values ('TSTEMP left', 3000, '2019-01-31');
  n := public.generate_payslips(v_period);
  assert n = 0, 'P6: an employee who left in January got a March payslip';

  ------------------------------------------------------------------- the sum
  insert into public.payslip_items (payslip_id, component_id, amount, label)
  values (v_slip, c_comm, 500, 'عمولة على 10 اشتراكات');
  insert into public.payslip_items (payslip_id, component_id, amount)
  values (v_slip, c_bonus, 200);
  insert into public.payslip_items (payslip_id, component_id, amount)
  values (v_slip, c_ded, 100);

  select earnings_total, deductions_total, net_amount into v_earn, v_ded, v_net
    from public.payslips where id = v_slip;
  assert v_earn = 700 and v_ded = 100 and v_net = 6600,
    format('P7: totals are %s / %s / %s, expected 700 / 100 / 6600', v_earn, v_ded, v_net);

  -- P8: direction is snapshotted from the component, never sent by the client
  assert (select count(*) from public.payslip_items
           where payslip_id = v_slip and direction = 'deduction') = 1,
    'P8: the deduction line did not take its direction from the component';

  -- P9: a line with no label of its own takes the component's name
  assert (select label from public.payslip_items
           where payslip_id = v_slip and component_id = c_bonus) is not null,
    'P9: an unlabelled line was left unlabelled';

  -- P10: the message split adds up — base + commissions + bonus - deductions = net
  assert (select base_salary + commissions_total + bonus_total - deductions_total
            from public.v_payslips where id = v_slip) = v_net,
    'P10: the commission/bonus split does not reconstruct the net';

  -- P11: deductions cannot exceed the salary
  v_failed := false;
  begin
    insert into public.payslip_items (payslip_id, component_id, amount)
    values (v_slip, c_ded, 99999);
  exception when others then v_failed := true;
  end;
  assert v_failed, 'P11: deductions were allowed past the salary';

  ----------------------------------------------------------------- the order
  -- P12: nothing is paid before the cycle is approved
  r := public.pay_payslip(v_slip, v_wallet);
  assert (r ->> 'reason') = 'not_approved',
    'P12: a draft cycle paid out: ' || r::text;

  update public.payroll_periods set status = 'review'   where id = v_period;
  update public.payroll_periods set status = 'approved' where id = v_period;

  -- P13: approving stamps who and when
  assert (select approved_by from public.payroll_periods where id = v_period) = v_admin,
    'P13: approved_by was not stamped';

  -- P14: an approved cycle does not silently accept another name
  v_failed := false;
  begin
    insert into public.payslips (period_id, employee_id, employee_name, base_salary)
    values (v_period, v_emp, 'TSTEMP two', 1000);
  exception when others then v_failed := true;
  end;
  assert v_failed, 'P14: somebody was added to an approved cycle';

  ----------------------------------------------------------------- the money
  select balance into v_before from public.v_wallet_balances where id = v_wallet;
  r := public.pay_payslip(v_slip, v_wallet, '2019-03-28T12:00:00Z'::timestamptz, 'اختبار');
  assert (r ->> 'ok')::boolean, 'P15: paying failed: ' || r::text;
  v_entry := (r ->> 'ledger_entry_id')::uuid;

  -- P16: the wallet moved by exactly the net, in the same transaction
  select balance into v_after from public.v_wallet_balances where id = v_wallet;
  assert v_after - v_before = -v_net,
    format('P16: the wallet moved %s, expected %s', v_after - v_before, -v_net);

  -- P17: the ledger row explains itself without a join
  assert (select description from public.ledger_entries where id = v_entry)
         like 'مرتب%مارس 2019',
    'P17: the ledger description does not name the person and the month';
  assert (select metadata ->> 'payslip_id' from public.ledger_entries where id = v_entry)
         = v_slip::text,
    'P17b: the ledger row does not point back at its payslip';
  assert (select entry_type::text from public.ledger_entries where id = v_entry) = 'expense',
    'P17c: a salary is an expense';

  -- P18: the cycle closes itself when the last person is paid
  assert (select status from public.payroll_periods where id = v_period) = 'closed',
    'P18: the cycle did not close after the last payment';

  -- P19: paying twice is refused, not doubled
  r := public.pay_payslip(v_slip, v_wallet);
  assert (r ->> 'reason') = 'already_paid', 'P19: a salary was paid twice: ' || r::text;

  ----------------------------------------------------------------- the rails
  -- P20: a paid payslip is frozen
  v_failed := false;
  begin
    update public.payslips set base_salary = 9999 where id = v_slip;
  exception when others then v_failed := true;
  end;
  assert v_failed, 'P20: a paid payslip was edited';

  -- P21: ...including its lines
  v_failed := false;
  begin
    insert into public.payslip_items (payslip_id, component_id, amount)
    values (v_slip, c_bonus, 50);
  exception when others then v_failed := true;
  end;
  assert v_failed, 'P21: a line was added to a paid payslip';

  -- P22: ...and it cannot be deleted
  v_failed := false;
  begin
    delete from public.payslips where id = v_slip;
  exception when others then v_failed := true;
  end;
  assert v_failed, 'P22: a paid payslip was deleted';

  -- P23: paid_at is not a column a client may write. Without this, anyone with
  -- payroll.write could mark a salary paid and no money would ever move.
  v_failed := false;
  begin
    update public.payslips set paid_at = now() where id = v_slip;
  exception when others then v_failed := true;
  end;
  assert v_failed, 'P23: paid_at was written directly';

  -- P24: the salary entry cannot be voided from the ledger side, or the
  -- payslip and the books would disagree about the same fact
  v_failed := false;
  begin
    perform public.void_ledger_entry(v_entry, 'من الدفتر');
  exception when others then v_failed := true;
  end;
  assert v_failed, 'P24: a salary entry was voided from the ledger';

  --------------------------------------------------------------- the reversal
  r := public.unpay_payslip(v_slip, 'تراجع');
  assert (r ->> 'ok')::boolean, 'P25: reversing failed: ' || r::text;

  -- P26: voided, never deleted (rule 6)
  assert (select voided_at is not null from public.ledger_entries where id = v_entry),
    'P26: the entry was not voided';
  assert (select count(*) from public.ledger_entries where id = v_entry) = 1,
    'P26b: the entry was deleted instead of voided';

  -- P27: the money comes back
  select balance into v_after from public.v_wallet_balances where id = v_wallet;
  assert v_after = v_before,
    format('P27: the wallet is at %s, expected %s', v_after, v_before);

  -- P28: the trail survives — the voided row still names its payslip
  assert (select metadata ->> 'payslip_id' from public.ledger_entries where id = v_entry)
         = v_slip::text,
    'P28: the reversal lost the link to its payslip';

  -- P29: the cycle is open again, because somebody in it is unpaid again
  assert (select status from public.payroll_periods where id = v_period) = 'approved',
    'P29: the cycle stayed closed with an unpaid salary in it';
  assert (select paid_at is null from public.payslips where id = v_slip),
    'P29b: the payslip still says paid';

  ------------------------------------------------------- the record families
  -- P30: an employee with payslips is not deletable, and says why
  r := public.describe_record('employee', v_emp);
  assert not (r ->> 'can_delete')::boolean, 'P30: an employee with payslips looked deletable';
  assert (r ->> 'blocked_reason') = 'in_use', 'P30b: no reason given: ' || r::text;

  -- P31: archiving is the way out, and keeps the history
  r := public.archive_record('employee', v_emp, true);
  assert (r ->> 'ok')::boolean, 'P31: archiving an employee failed: ' || r::text;
  assert not (select is_active from public.employees where id = v_emp),
    'P31b: the employee is still active';

  -- P32: a system component is renameable and never deletable
  r := public.describe_record('salary_component', c_comm);
  assert (r ->> 'blocked_reason') = 'system_record',
    'P32: the commission component looked removable: ' || r::text;

  raise notice 'ALL PAYROLL TESTS PASSED';
end $$;

rollback;
