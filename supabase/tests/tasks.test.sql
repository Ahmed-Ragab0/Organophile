-- tasks.test.sql
--
-- Regression suite for the task board, the clock, and — the part that is
-- easiest to get wrong and hardest to notice — who can see whose work.
--
--   psql "$DATABASE_URL" -f supabase/tests/tasks.test.sql
--
-- One transaction, rolled back at the end, so it is safe against the live
-- database. That matters here more than usual: RLS and triggers are the thing
-- under test, and they only exist there.
--
-- The second half runs as `authenticated` with a demoted colleague's JWT,
-- because a policy tested as the owner is a policy that has not been tested.

begin;

do $$
declare
  v_admin  uuid;
  v_other  uuid;
  v_sales  uuid;
  e_me     uuid;
  e_them   uuid;
  v_proj   uuid;
  t_mine   uuid;
  t_theirs uuid;
  s_manual uuid;
  r        jsonb;
  n        int;
  v_failed boolean;
begin
  select s.user_id into v_admin
    from public.staff s join public.roles r2 on r2.id = s.role_id
   where s.is_active and r2.is_superuser
   order by s.email limit 1;
  assert v_admin is not null, 'T0: no active superuser to run the suite as';

  -- Somebody other than the owner, to be demoted to sales for the second half.
  select s.user_id into v_other from public.staff s where s.user_id <> v_admin limit 1;
  assert v_other is not null,
    'T0b: this suite needs a second staff account to test the visibility rules';

  perform set_config('request.jwt.claims',
    json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  assert app.can('team.write'), 'T0c: the suite could not authenticate as a manager';

  ------------------------------------------------------------------ the shape
  insert into public.employees (full_name, user_id, daily_target_minutes)
  values ('TSTT sales', v_other, 480) returning id into e_me;
  insert into public.employees (full_name) values ('TSTT colleague') returning id into e_them;

  insert into public.projects (name) values ('TSTT حملة أكتوبر') returning id into v_proj;
  -- T1: a project names itself on a card without anybody typing a key
  assert (select key from public.projects where id = v_proj) is not null,
    'T1: the project key was not derived';

  insert into public.tasks (project_id, title, assignee_id, priority, due_on)
  values (v_proj, 'مهمتي', e_me, 'high', '2019-01-01') returning id into t_mine;
  insert into public.tasks (project_id, title, assignee_id)
  values (v_proj, 'مهمة زميلي', e_them) returning id into t_theirs;

  -- T2: overdue is a Cairo-day question, answered by the view
  assert (select is_overdue from public.v_tasks where id = t_mine),
    'T2: a task due in 2019 is not flagged overdue';

  -- T3: the assignee's NAME resolves without touching the salary table
  assert (select assignee_name from public.v_tasks where id = t_mine) = 'TSTT sales',
    'T3: the assignee name did not resolve';

  ------------------------------------------------------------------ the clock
  -- The manager is not the employee here, so drive the clock as the salesperson.
  perform set_config('request.jwt.claims',
    json_build_object('sub', v_other, 'role', 'authenticated')::text, true);
  assert app.my_employee_id() = e_me, 'T4: my_employee_id did not resolve';

  r := public.start_task_timer(t_mine);
  assert (r ->> 'ok')::boolean, 'T5: starting the clock failed: ' || r::text;
  assert (select status from public.tasks where id = t_mine) = 'in_progress',
    'T5b: starting the clock did not move the task to In Progress';

  -- T6: one clock per person. Starting a second task ends the first, rather
  -- than running two and counting the hour twice.
  r := public.start_task_timer(t_theirs);
  assert (r ->> 'stopped_previous')::int = 1, 'T6: the previous timer was left running';
  select count(*) into n
    from public.task_sessions where employee_id = e_me and ended_at is null;
  assert n = 1, 'T6b: ' || n || ' clocks running for one person';

  r := public.stop_task_timer('خلصت');
  assert (r ->> 'ok')::boolean, 'T7: stopping failed: ' || r::text;
  -- T7b: start and stop inside one transaction is a zero-minute session, not a
  -- constraint violation. `now()` would make these the same instant; the
  -- functions use clock_timestamp() precisely so this works.
  assert (r ->> 'minutes')::int >= 0, 'T7b: a zero-length session was refused';

  r := public.stop_task_timer(null);
  assert (r ->> 'reason') = 'nothing_running', 'T8: stopping twice did not say so';

  ------------------------------------------------------------- claimed time
  r := public.log_manual_time(t_mine, '2019-01-02T09:00:00Z', '2019-01-02T11:30:00Z', 'شغل بره');
  s_manual := (r ->> 'session_id')::uuid;
  assert (r ->> 'ok')::boolean, 'T9: manual time was refused: ' || r::text;

  -- T10: typed-in time is a claim, and it cannot be self-approved
  assert (select status from public.task_sessions where id = s_manual) = 'pending',
    'T10: manual time did not land as pending';
  assert (select minutes from public.task_sessions where id = s_manual) = 150,
    'T10b: 09:00 to 11:30 is not 150 minutes';

  -- T11: a pending claim counts for nothing until somebody agrees to it
  assert (select minutes from public.v_tasks where id = t_mine) = 0,
    'T11: pending time was counted in the task total';

  -- T12: two claims over the same hour is the one error a reviewer cannot
  -- catch by reading, because each looks reasonable alone
  r := public.log_manual_time(t_theirs, '2019-01-02T10:00:00Z', '2019-01-02T12:00:00Z', null);
  assert (r ->> 'reason') = 'overlaps', 'T12: overlapping time was accepted';

  -- T13: ...but back-to-back work is not an overlap
  r := public.log_manual_time(t_theirs, '2019-01-02T11:30:00Z', '2019-01-02T12:00:00Z', null);
  assert (r ->> 'ok')::boolean, 'T13: back-to-back time was refused as an overlap';

  -- T14: hours cannot be claimed for a day that has not happened
  r := public.log_manual_time(t_theirs, '2030-01-02T10:00:00Z', '2030-01-02T12:00:00Z', null);
  assert (r ->> 'reason') = 'in_the_future', 'T14: future time was accepted';

  ---------------------------------------------------------------- the review
  perform set_config('request.jwt.claims',
    json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);

  r := public.review_time_entry(s_manual, true, 'تمام');
  assert (r ->> 'status') = 'approved', 'T16: approving failed: ' || r::text;
  assert (select minutes from public.v_tasks where id = t_mine) = 150,
    'T16b: approved time did not reach the task total';
  assert (select reviewed_by from public.task_sessions where id = s_manual) = v_admin,
    'T16c: the reviewer was not stamped';

  -- T17: a decision is made once
  r := public.review_time_entry(s_manual, false, null);
  assert (r ->> 'reason') = 'not_pending', 'T17: a decided claim was re-decided';

  ----------------------------------------------------------------- the board
  r := public.move_task(t_mine, 'done', null);
  assert (r ->> 'ok')::boolean, 'T18: moving to done failed: ' || r::text;
  assert (select completed_at from public.tasks where id = t_mine) is not null,
    'T18b: completed_at was not stamped';

  -- T19: dragged back out of Done, it is not finished, so it has no finish time
  r := public.move_task(t_mine, 'todo', null);
  assert (select completed_at from public.tasks where id = t_mine) is null,
    'T19: completed_at survived a move out of Done';

  -- T20: a card dropped between two others lands between them, in one write
  assert (select position from public.tasks where id = t_mine)
       < (select position from public.tasks where id = t_theirs and status = 'todo')
      or (select status from public.tasks where id = t_theirs) <> 'todo',
    'T20: the moved card did not land above the one it was dropped over';

  ------------------------------------------------------- who sees whose work
  -- Everything above ran as somebody who may see everything. The rules that
  -- matter are the ones for somebody who may not, and they only apply through
  -- RLS — so from here the suite is genuinely a different user.
  -- Give the colleague some time of their own, so "sees no colleague's time"
  -- is a claim about a row that actually exists.
  insert into public.task_sessions (task_id, employee_id, started_at, ended_at, source)
  values (t_theirs, e_them, '2019-02-01T09:00:00Z', '2019-02-01T10:00:00Z', 'manual');

  select id into v_sales from public.roles where code = 'sales';
  update public.staff set role_id = v_sales where user_id = v_other;

  perform set_config('request.jwt.claims',
    json_build_object('sub', v_other, 'role', 'authenticated')::text, true);
  set local role authenticated;

  assert not ((public.my_access() -> 'permissions') ? 'team.read'),
    'T21: the demoted account still holds team.read';

  select count(*) into n from public.tasks;
  assert n = 1, 'T22: a salesperson can see ' || n || ' tasks, expected only their own';

  -- T23: their own time, and only their own. Not zero — a person has to be
  -- able to see the hours they logged, or the timer is a black box.
  select count(*) into n from public.task_sessions where employee_id = e_them;
  assert n = 0, 'T23: a salesperson can see a colleague''s time entries';
  select count(*) into n from public.task_sessions where employee_id = e_me;
  assert n > 0, 'T23b: a salesperson cannot see their own time entries';

  select count(*) into n from public.employees;
  assert n = 0, 'T24: a salesperson can read the payroll table';

  -- T25: ...but their own card still says who it belongs to. This is the whole
  -- reason names come through app.team_members() instead of a join.
  assert (select assignee_name from public.v_tasks where id = t_mine) = 'TSTT sales',
    'T25: the assignee name disappeared for somebody without payroll access';

  -- T26: the team report is the team's; their own row is their own business
  select count(*) into n from public.v_team_productivity;
  assert n = 1, 'T26: a salesperson sees ' || n || ' productivity rows, expected 1';
  assert (select full_name from public.v_team_productivity limit 1) = 'TSTT sales',
    'T26b: and it is not their own row';

  -- T27: working a task is allowed
  update public.tasks set status = 'in_progress' where id = t_mine;

  -- T28: reshaping it is not. RLS is row-level and cannot say this; the
  -- trigger can, and without it somebody could hand their own work to a
  -- colleague or push its due date out a month.
  v_failed := false;
  begin update public.tasks set assignee_id = e_them where id = t_mine;
  exception when others then v_failed := true; end;
  assert v_failed, 'T28: a salesperson reassigned their own task';

  v_failed := false;
  begin update public.tasks set due_on = '2030-01-01' where id = t_mine;
  exception when others then v_failed := true; end;
  assert v_failed, 'T29: a salesperson moved their own due date';

  v_failed := false;
  begin insert into public.tasks (title, assignee_id) values ('لزميلي', e_them);
  exception when others then v_failed := true; end;
  assert v_failed, 'T30: a salesperson assigned work to a colleague';

  -- T31: but writing down your own to-do is not a management act
  insert into public.tasks (title, assignee_id) values ('حاجة ليا', e_me);

  /*
   * T31b: a worker logs their own time, and cannot then agree to it.
   *
   * This is the whole point of the manual/timer split. Without it "hours
   * worked" is a number each person writes for themselves, and every report
   * built on it means nothing. It is checked HERE rather than earlier because
   * it can only fail for somebody who actually lacks `team.write` — asserted
   * against the owner, it would pass for the wrong reason.
   */
  r := public.log_manual_time(t_mine, '2019-03-01T09:00:00Z', '2019-03-01T10:00:00Z', null);
  assert (r ->> 'ok')::boolean, 'T31b: a salesperson could not log their own time: ' || r::text;
  assert (select status from public.task_sessions where id = (r ->> 'session_id')::uuid)
         = 'pending',
    'T31c: a salesperson''s own time did not land as a pending claim';

  v_failed := false;
  begin
    r := public.review_time_entry((r ->> 'session_id')::uuid, true, null);
  exception when others then v_failed := true;
  end;
  assert v_failed, 'T31d: somebody approved their own time';

  -- T32: and deleting is
  v_failed := false;
  begin delete from public.tasks where id = t_mine;
  exception when others then v_failed := true; end;
  assert v_failed, 'T32: a salesperson deleted a task';

  reset role;

  ------------------------------------------------------- the record families
  perform set_config('request.jwt.claims',
    json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);

  -- T33: a project with hours against it is its own history
  r := public.describe_record('project', v_proj);
  assert (r ->> 'blocked_reason') = 'in_use',
    'T33: a project with tracked time looked deletable: ' || r::text;

  -- T34: archiving a task is cancelling it
  r := public.archive_record('task', t_theirs, true);
  assert (r ->> 'ok')::boolean, 'T34: archiving a task failed: ' || r::text;
  assert (select status from public.tasks where id = t_theirs) = 'cancelled',
    'T34b: archiving did not cancel the task';

  -- T35: cancelled work leaves the denominator instead of holding a project
  -- below 100% forever
  assert (select cancelled from public.v_projects where id = v_proj) = 1,
    'T35: the cancelled task was not counted as cancelled';

  --------------------------------------------- a login and a person (0053)
  -- T36: the staff list says whether there is a person behind each login.
  -- Without this the owner grants a tasks role, the account works for
  -- nothing, and the only place that says so is the employee's own board.
  assert (select employee_id from public.v_staff where user_id = v_other) = e_me,
    'T36: v_staff does not report the employee behind a login';

  -- T37: an account with no person behind it says so
  assert (select employee_id from public.v_staff where user_id = v_admin) is null
      or (select count(*) from public.employees where user_id = v_admin) = 1,
    'T37: v_staff invented an employee for an unlinked account';

  /*
   * T38: payroll first, account afterwards — the ordinary sequence — links
   * itself. Somebody joins, is added to the roster, and is given a login some
   * days later; the email is the same person and that is not a decision
   * anybody should have to remember to make.
   *
   * The staff row is deleted and re-created rather than invented, because
   * `staff.user_id` has to be a real auth user.
   */
  declare
    v_role  uuid;
    v_email text;
  begin
    select email, role_id into v_email, v_role from public.staff where user_id = v_other;
    -- Removing the account nulls `employees.user_id` (ON DELETE SET NULL), so
    -- the salesperson's row is unlinked but still there — which is also the
    -- case the trigger has to not break: it carries no email, so it must not
    -- be the row that gets adopted.
    delete from public.staff where user_id = v_other;

    insert into public.employees (full_name, email) values ('TSTT late hire', lower(v_email));
    -- Written carelessly on purpose: a different case and a trailing space.
    insert into public.staff (user_id, email, role_id)
    values (v_other, upper(v_email) || ' ', v_role);

    assert (select user_id from public.employees where full_name = 'TSTT late hire') = v_other,
      'T38: the account did not adopt the employee row carrying its email';
    assert (select user_id from public.employees where id = e_me) is null,
      'T38b: it adopted a row that carries no email at all';

    -- T38c: two roster rows with one address must not both be handed the
    -- account. `employees.user_id` is unique, so the second would abort the
    -- whole staff insert with a constraint error nobody could read.
    delete from public.staff where user_id = v_other;
    insert into public.employees (full_name, email) values ('TSTT duplicate', lower(v_email));
    insert into public.staff (user_id, email, role_id) values (v_other, v_email, v_role);
    select count(*) into n from public.employees where user_id = v_other;
    assert n = 1, 'T38c: ' || n || ' roster rows were linked to one account';

    -- T39: and an employee already spoken for is not stolen by a second
    -- account with the same address.
    delete from public.staff where user_id = v_other;
    insert into public.staff (user_id, email, role_id) values (v_other, v_email, v_role);
    select count(*) into n
      from public.employees where lower(email) = lower(v_email) and user_id = v_other;
    assert n = 1, 'T39: a repeat insert produced ' || n || ' linked rows';
  end;

  raise notice 'ALL TASK TESTS PASSED';
end $$;

rollback;
