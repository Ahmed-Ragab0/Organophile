-- Tasks, part two: the clock, and who agrees to what it says.
--
-- Starting and stopping a timer looks like two UPDATEs, and it is not. The
-- thing that makes a tracked hour worth anything is that it cannot overlap
-- another one, cannot be started on somebody else's behalf, and cannot be
-- edited into existence afterwards without somebody agreeing to it. All three
-- live here, in functions, for the same reason money movements do (rule 8):
-- a rule that only the front end knows is a rule that holds until the second
-- caller.

-- ---------------------------------------------------------------------------
-- Starting
-- ---------------------------------------------------------------------------
/**
 * A note on `clock_timestamp()`, which appears wherever this file marks the
 * boundary of a session.
 *
 * `now()` is the TRANSACTION's start time and does not move while the
 * transaction runs, so a start and a stop inside one of them land on the same
 * instant — a zero-length session that the check constraint then refuses. A
 * stopwatch is a claim about the wall clock at the moment a button was
 * pressed, and that is what `clock_timestamp()` is. `now()` stays correct for
 * everything else here, where "when did this change" means the transaction.
 */
/**
 * Put the clock on a task.
 *
 * Anything already running for this person stops first. That is not a
 * convenience — the partial unique index would refuse the insert, and the
 * honest reading of "I started something else" is that the previous thing
 * ended, not that the request was invalid.
 *
 * The task also moves to In Progress, because it now is.
 */
create or replace function public.start_task_timer(p_task_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $function$
declare
  v_me      uuid := app.my_employee_id();
  v_session uuid;
  v_stopped int := 0;
  v_status  text;
begin
  if not (app.can('tasks.write') or app.can('team.write')) then
    raise exception 'forbidden';
  end if;
  if v_me is null then
    -- Signed in, allowed to work, but not on the payroll list — so there is no
    -- person for the hours to belong to. Named rather than raised: the screen
    -- can explain it, and it is somebody's setup, not their mistake.
    return jsonb_build_object('ok', false, 'reason', 'not_an_employee');
  end if;

  select status into v_status from public.tasks where id = p_task_id;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'not_found');
  end if;
  if v_status in ('done', 'cancelled') then
    return jsonb_build_object('ok', false, 'reason', 'task_closed');
  end if;

  update public.task_sessions
     set ended_at = clock_timestamp(), updated_at = now()
   where employee_id = v_me and ended_at is null;
  get diagnostics v_stopped = row_count;

  insert into public.task_sessions (task_id, employee_id, started_at, source, status)
  values (p_task_id, v_me, clock_timestamp(), 'timer', 'tracked')
  returning id into v_session;

  update public.tasks
     set status = 'in_progress', updated_at = now()
   where id = p_task_id and status = 'todo';

  return jsonb_build_object(
    'ok', true, 'session_id', v_session, 'stopped_previous', v_stopped);
end;
$function$;

comment on function public.start_task_timer is
  'Starts the caller''s clock on a task, stopping whatever it was on before. '
  'One clock per person, enforced by index as well as by this.';

-- ---------------------------------------------------------------------------
-- Stopping
-- ---------------------------------------------------------------------------
create or replace function public.stop_task_timer(p_note text default null)
returns jsonb language plpgsql security definer set search_path = '' as $function$
declare
  v_me      uuid := app.my_employee_id();
  v_session uuid;
  v_minutes int;
begin
  if not (app.can('tasks.write') or app.can('team.write')) then
    raise exception 'forbidden';
  end if;
  if v_me is null then
    return jsonb_build_object('ok', false, 'reason', 'not_an_employee');
  end if;

  update public.task_sessions
     set ended_at = clock_timestamp(),
         note = coalesce(nullif(btrim(coalesce(p_note, '')), ''), note),
         updated_at = now()
   where employee_id = v_me and ended_at is null
  returning id into v_session;

  if v_session is null then
    return jsonb_build_object('ok', false, 'reason', 'nothing_running');
  end if;

  select minutes into v_minutes from public.task_sessions where id = v_session;
  return jsonb_build_object('ok', true, 'session_id', v_session, 'minutes', v_minutes);
end;
$function$;

-- ---------------------------------------------------------------------------
-- Typing time in
-- ---------------------------------------------------------------------------
/**
 * Record a stretch of time that the app did not watch.
 *
 * It lands as `pending` and is worth nothing until reviewed — see the guard in
 * 0051, which refuses to let anybody set their own status. Overlap with time
 * already logged is refused outright: two claims covering the same hour is the
 * one error a reviewer cannot catch by reading, because both entries look
 * perfectly reasonable on their own.
 */
create or replace function public.log_manual_time(
  p_task_id    uuid,
  p_started_at timestamptz,
  p_ended_at   timestamptz,
  p_note       text default null
) returns jsonb language plpgsql security definer set search_path = '' as $function$
declare
  v_me      uuid := app.my_employee_id();
  v_session uuid;
begin
  if not (app.can('tasks.write') or app.can('team.write')) then
    raise exception 'forbidden';
  end if;
  if v_me is null then
    return jsonb_build_object('ok', false, 'reason', 'not_an_employee');
  end if;

  if p_started_at is null or p_ended_at is null or p_ended_at <= p_started_at then
    return jsonb_build_object('ok', false, 'reason', 'bad_range');
  end if;
  if p_ended_at > now() + interval '1 minute' then
    return jsonb_build_object('ok', false, 'reason', 'in_the_future');
  end if;
  if p_ended_at - p_started_at > interval '24 hours' then
    return jsonb_build_object('ok', false, 'reason', 'too_long');
  end if;
  if not exists (select 1 from public.tasks where id = p_task_id) then
    return jsonb_build_object('ok', false, 'reason', 'not_found');
  end if;

  -- Half-open comparison: a session ending at 14:00 and one starting at 14:00
  -- do not overlap, and treating them as if they did makes back-to-back work
  -- impossible to record.
  if exists (
    select 1 from public.task_sessions ts
     where ts.employee_id = v_me
       and ts.status <> 'rejected'
       and ts.started_at < p_ended_at
       and coalesce(ts.ended_at, now()) > p_started_at
  ) then
    return jsonb_build_object('ok', false, 'reason', 'overlaps');
  end if;

  insert into public.task_sessions
    (task_id, employee_id, started_at, ended_at, source, note)
  values (p_task_id, v_me, p_started_at, p_ended_at, 'manual',
          nullif(btrim(coalesce(p_note, '')), ''))
  returning id into v_session;

  return jsonb_build_object('ok', true, 'session_id', v_session);
end;
$function$;

-- ---------------------------------------------------------------------------
-- Agreeing to it
-- ---------------------------------------------------------------------------
create or replace function public.review_time_entry(
  p_session_id uuid,
  p_approve    boolean,
  p_note       text default null
) returns jsonb language plpgsql security definer set search_path = '' as $function$
declare v_status text;
begin
  if not app.can('team.write') then raise exception 'forbidden'; end if;

  select status into v_status from public.task_sessions where id = p_session_id;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'not_found');
  end if;
  if v_status <> 'pending' then
    -- Already decided. Saying so beats silently re-deciding it, which would
    -- move an hour back into the totals a week after somebody removed it.
    return jsonb_build_object('ok', false, 'reason', 'not_pending', 'status', v_status);
  end if;

  update public.task_sessions
     set status      = case when p_approve then 'approved' else 'rejected' end,
         note        = coalesce(nullif(btrim(coalesce(p_note, '')), ''), note),
         reviewed_by = auth.uid(),
         reviewed_at = now(),
         updated_at  = now()
   where id = p_session_id;

  return jsonb_build_object(
    'ok', true, 'status', case when p_approve then 'approved' else 'rejected' end);
end;
$function$;

comment on function public.review_time_entry is
  'A manager agrees to, or refuses, a stretch of time somebody typed in. The '
  'only way a session leaves `pending`.';

-- ---------------------------------------------------------------------------
-- Moving a card
-- ---------------------------------------------------------------------------
/**
 * Put a task in a column, at a place in it.
 *
 * One call rather than an UPDATE from the browser because the position is
 * arithmetic on the neighbours, and doing that arithmetic client-side means
 * two people dragging at once compute it from two different pictures of the
 * board. Here it is read and written inside one statement.
 *
 * `p_after_id` is the card it should land BELOW; null means the top.
 */
create or replace function public.move_task(
  p_task_id  uuid,
  p_status   text,
  p_after_id uuid default null
) returns jsonb language plpgsql security definer set search_path = '' as $function$
declare
  v_after  numeric;
  v_before numeric;
  v_new    numeric;
begin
  if not (app.can('tasks.write') or app.can('team.write')) then
    raise exception 'forbidden';
  end if;
  if p_status not in ('todo', 'in_progress', 'done', 'cancelled') then
    return jsonb_build_object('ok', false, 'reason', 'bad_status');
  end if;
  if not exists (select 1 from public.tasks where id = p_task_id) then
    return jsonb_build_object('ok', false, 'reason', 'not_found');
  end if;

  if p_after_id is null then
    -- The top of the column: one step above whatever is currently highest.
    select coalesce(min(position), 0) - 1024 into v_new
      from public.tasks where status = p_status and id <> p_task_id;
  else
    select position into v_after
      from public.tasks where id = p_after_id and status = p_status;
    if v_after is null then
      return jsonb_build_object('ok', false, 'reason', 'bad_anchor');
    end if;

    select min(position) into v_before
      from public.tasks
     where status = p_status and position > v_after and id <> p_task_id;

    -- Between two cards, or below the last one.
    v_new := case when v_before is null then v_after + 1024
                  else (v_after + v_before) / 2 end;
  end if;

  -- The trigger in 0051 decides whether this caller may move THIS task, and
  -- stamps started_at / completed_at from the new status.
  update public.tasks
     set status = p_status, position = v_new, updated_at = now()
   where id = p_task_id;

  return jsonb_build_object('ok', true, 'status', p_status, 'position', v_new);
end;
$function$;

do $$
declare f text;
begin
  foreach f in array array[
    'public.start_task_timer(uuid)',
    'public.stop_task_timer(text)',
    'public.log_manual_time(uuid, timestamptz, timestamptz, text)',
    'public.review_time_entry(uuid, boolean, text)',
    'public.move_task(uuid, text, uuid)'
  ] loop
    -- The default grant is EXECUTE TO PUBLIC and `anon` holds it by
    -- membership; revoking from `anon` alone removes nothing (0045).
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end $$;

-- ===========================================================================
-- The record verbs learn two more families
-- ===========================================================================
create or replace function app.record_links_project(p_id uuid)
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

  select true, p.name, not p.is_active
    into is_found, label, archived
    from public.projects p where p.id = p_id;

  if not coalesce(is_found, false) then return next; return; end if;

  -- Tasks do not block the delete: the foreign key is ON DELETE SET NULL, so
  -- they survive and simply stop naming a project. Counted anyway, because
  -- "this detaches 43 tasks" is the thing worth knowing before agreeing.
  select count(*) into n from public.tasks where project_id = p_id;
  if n > 0 then
    v_links := v_links || jsonb_build_object('what', 'tasks', 'count', n, 'money', false);
  end if;

  select count(*) into n
    from public.task_sessions ts
    join public.tasks t on t.id = ts.task_id
   where t.project_id = p_id;
  if n > 0 then
    v_links := v_links || jsonb_build_object('what', 'task_sessions', 'count', n, 'money', false);
    -- Hours already recorded against this project ARE its history. Detaching
    -- them would leave a report that cannot say what the time was spent on.
    blocked_reason := 'in_use';
  end if;

  links := v_links;
  return next;
end;
$function$;

create or replace function app.record_links_task(p_id uuid)
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
  is_found := false; archived := false;
  -- Cancelling is what archiving means for a task, and `cancelled` is one of
  -- the four statuses rather than a flag of its own — so the generic archive
  -- verb has something real to set.
  archivable := true;
  money_count := 0; money_amount := 0;

  select true, t.title, t.status = 'cancelled'
    into is_found, label, archived
    from public.tasks t where t.id = p_id;

  if not coalesce(is_found, false) then return next; return; end if;

  select count(*) into n from public.task_sessions where task_id = p_id;
  if n > 0 then
    v_links := v_links || jsonb_build_object('what', 'task_sessions', 'count', n, 'money', false);
    blocked_reason := 'in_use';
  end if;

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
    when 'project' then
      return query select * from app.record_links_project(p_id);
    when 'task' then
      return query select * from app.record_links_task(p_id);
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
    when 'project' then
      delete from public.projects where id = p_id; return found;
    when 'task' then
      delete from public.tasks where id = p_id; return found;
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
      update public.employees
         set is_active = not p_archived, updated_at = now() where id = p_id;
      return found;
    when 'salary_component' then
      update public.salary_components
         set is_active = not p_archived, updated_at = now() where id = p_id;
      return found;
    when 'project' then
      update public.projects
         set is_active = not p_archived, updated_at = now() where id = p_id;
      return found;
    when 'task' then
      -- Archiving a task is cancelling it; un-archiving puts it back in To Do
      -- rather than guessing which column it came from.
      update public.tasks
         set status = case when p_archived then 'cancelled' else 'todo' end,
             updated_at = now()
       where id = p_id;
      return found;
    else
      return null;
  end case;
end;
$function$;

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
    -- Both of these answer to `team`, not to `tasks`: deleting a project or a
    -- task is a management act, and `tasks.write` is the permission for doing
    -- your own work rather than for reshaping everybody's.
    when 'project'           then 'team'
    when 'task'              then 'team'
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
  select string_agg(p.proname, ', ') into v_bad
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname in ('start_task_timer', 'stop_task_timer', 'log_manual_time',
                       'review_time_entry', 'move_task', 'describe_record',
                       'delete_record', 'archive_record')
     and has_function_privilege('anon', p.oid, 'execute');
  if v_bad is not null then
    raise exception 'anon can execute: %', v_bad;
  end if;

  foreach v_bad in array array['project', 'task'] loop
    if app.record_kind_permission(v_bad, 'write') like 'staff.%' then
      raise exception 'record kind % has no permission of its own', v_bad;
    end if;
  end loop;

  select count(*) into v_n
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname in ('public', 'app')
     and p.prosrc like '%is_admin()%'
     and p.proname <> 'is_admin';
  if v_n > 0 then
    raise exception '% function(s) still guard with app.is_admin()', v_n;
  end if;
end $$;
