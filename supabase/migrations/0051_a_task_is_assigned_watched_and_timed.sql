-- Tasks, part one: the shape of the work.
--
-- The payroll system answers "what did this person cost". This answers "what
-- did this person do" — and those are the two halves of the same question the
-- owner actually has, which is whether the second is worth the first.
--
--   project  → a body of work with a short key, so a card can name it
--   task     → one thing, assigned to one person, in one of four states
--   session  → a stretch of time spent on a task, timed or typed in
--
-- Two design decisions worth stating before the SQL, because everything else
-- follows from them:
--
-- 1. A task is assigned to an EMPLOYEE, not to a login. `employees` is already
--    this system's answer to "who works here" (0049), and it is the list the
--    owner maintains. Somebody with no login can still be given tasks and
--    still shows up in the productivity report; they just cannot open the app
--    to see them. Assigning to `staff` instead would mean the roster of people
--    who do work and the roster of people who can sign in had to be the same
--    list, which they already are not.
--
-- 2. Seeing your own work and seeing everyone's are DIFFERENT permissions.
--    Every other domain in this database is all-or-nothing, and that was right
--    while every domain was about the business. This one is about people: a
--    salesperson must be able to work their own board without reading their
--    colleagues'. So `tasks.*` means yours and `team.*` means everybody's, and
--    the two-action rule from 0046 survives intact — it is a second domain,
--    not a third level of granularity.

-- ---------------------------------------------------------------------------
-- What there is to be allowed to do
-- ---------------------------------------------------------------------------
insert into public.permissions (code, domain, action, name, name_en, sort_order) values
  ('tasks.read',  'tasks', 'read',  'يشوف تاسكاته',            'View own tasks',    56),
  ('tasks.write', 'tasks', 'write', 'يشتغل على تاسكاته',       'Work own tasks',    57),
  ('team.read',   'team',  'read',  'يشوف شغل الفريق كله',     'View team work',    58),
  ('team.write',  'team',  'write', 'يوزّع التاسكات ويراجع الوقت', 'Assign & review', 59)
on conflict (code) do update
  set domain = excluded.domain, action = excluded.action,
      name = excluded.name, name_en = excluded.name_en,
      sort_order = excluded.sort_order;

-- Everybody who works gets their own board. Nobody but the owner gets the
-- team view by default: "who is doing what right now" is exactly the kind of
-- thing that should be granted deliberately rather than inherited.
insert into public.role_permissions (role_id, permission_code)
select r.id, p.code
  from public.roles r
  cross join (values ('tasks.read'), ('tasks.write')) as p(code)
 where r.code in ('accountant', 'sales')
on conflict do nothing;

-- ---------------------------------------------------------------------------
-- Which employee am I
-- ---------------------------------------------------------------------------
-- STABLE and SECURITY DEFINER for the same reason `app.can` is: this is read
-- from inside policies on tables that would otherwise have to read `employees`
-- through its own RLS, which needs `payroll.read` — and somebody working their
-- own task board has no business holding that.
create or replace function app.my_employee_id()
returns uuid language sql stable security definer set search_path = '' as $$
  select e.id from public.employees e
   where e.user_id = auth.uid() and e.is_active
   limit 1
$$;

comment on function app.my_employee_id is
  'The employee row belonging to the signed-in person, or null. Null is the '
  'normal case for the owner, who signs in without being on the payroll.';

grant execute on function app.my_employee_id() to authenticated;

-- ---------------------------------------------------------------------------
-- How long a day is
-- ---------------------------------------------------------------------------
-- On the employee rather than in settings: an assistant on four hours and a
-- full-timer on eight are both "at target", and one global number would make
-- one of them permanently red.
alter table public.employees
  add column if not exists daily_target_minutes int not null default 480
    check (daily_target_minutes between 0 and 1440);

comment on column public.employees.daily_target_minutes is
  'A working day for this person, in minutes. What the productivity bar is a '
  'proportion OF.';


-- ---------------------------------------------------------------------------
-- Who works here, without what they earn
-- ---------------------------------------------------------------------------
/**
 * The team, as names rather than as payroll rows.
 *
 * `employees` is gated on `payroll.read`, because that table holds what
 * everybody is paid. But a task board needs to write "assigned to Mariam" on
 * a card, and a sales manager who may see the team's work has no business
 * seeing the team's salaries. Joining `employees` into the task views would
 * have forced exactly that trade: either grant payroll to everyone with a
 * board, or show every card as unassigned.
 *
 * So the join goes through here instead. SECURITY DEFINER, and the columns it
 * returns are the whole of its promise: who somebody is and how long their
 * working day is. No salary, no phone, no wallet, no note. A colleague's name
 * is on the sidebar already; a colleague's pay is not.
 */
create or replace function app.team_members()
returns table (
  id                   uuid,
  full_name            text,
  job_title            text,
  is_active            boolean,
  user_id              uuid,
  daily_target_minutes int
) language sql stable security definer set search_path = '' as $function$
  select e.id, e.full_name, e.job_title, e.is_active, e.user_id, e.daily_target_minutes
    from public.employees e
   where app.can('team.read') or app.can('tasks.read') or app.can('payroll.read')
$function$;

grant execute on function app.team_members() to authenticated;

-- ---------------------------------------------------------------------------
-- Projects
-- ---------------------------------------------------------------------------
create table if not exists public.projects (
  id          uuid primary key default gen_random_uuid(),
  name        text not null check (btrim(name) <> ''),
  /**
   * The short code on the card — "PK", "SALES".
   *
   * A board card has room for the project once, at four or five characters.
   * Derived from the name when it is not given, so it is never blank and
   * never a thing anybody has to think about.
   */
  key         text unique,
  description text,
  /**
   * The card stripe. Stored as one of a fixed set of TOKEN names, not as a
   * hex: the palette belongs to the design system, and a colour picked here
   * would be the one thing on screen that does not follow the theme when it
   * flips to dark.
   */
  colour      text not null default 'brand'
              check (colour in ('brand', 'accent', 'ok', 'warn', 'danger', 'info', 'neutral')),
  is_active   boolean not null default true,
  sort_order  int not null default 100,
  created_by  uuid references auth.users(id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

comment on table public.projects is
  'A body of work tasks are filed under. The vocabulary of the board.';

create or replace function app.project_key()
returns trigger language plpgsql set search_path = '' as $function$
begin
  if nullif(btrim(coalesce(new.key, '')), '') is null then
    -- First letters of the first two words, uppercased, then a hash tail if
    -- that collides. Latin or Arabic both work; a two-letter Arabic key reads
    -- perfectly well on a card.
    new.key := upper(substr(regexp_replace(btrim(new.name), '\s+', '', 'g'), 1, 4));
    if exists (select 1 from public.projects p
                where p.key = new.key and p.id is distinct from new.id) then
      new.key := new.key || substr(md5(new.name || clock_timestamp()::text), 1, 3);
    end if;
  end if;
  new.key := upper(btrim(new.key));
  return new;
end;
$function$;

drop trigger if exists projects_fill_key on public.projects;
create trigger projects_fill_key
  before insert or update of key, name on public.projects
  for each row execute function app.project_key();

drop trigger if exists projects_touch_updated_at on public.projects;
create trigger projects_touch_updated_at
  before update on public.projects
  for each row execute function app.touch_updated_at();

drop trigger if exists projects_stamp_author on public.projects;
create trigger projects_stamp_author
  before insert on public.projects
  for each row execute function app.stamp_created_by();

-- ---------------------------------------------------------------------------
-- Tasks
-- ---------------------------------------------------------------------------
-- `status` and `priority` are text checks rather than tables, for the reason
-- given in 0049: the code branches on every one of these values. A fifth
-- column invented from a screen is a column nothing knows how to draw.
create table if not exists public.tasks (
  id          uuid primary key default gen_random_uuid(),
  project_id  uuid references public.projects(id) on delete set null,
  title       text not null check (btrim(title) <> ''),
  description text,
  status      text not null default 'todo'
              check (status in ('todo', 'in_progress', 'done', 'cancelled')),
  priority    text not null default 'medium'
              check (priority in ('low', 'medium', 'high', 'urgent')),
  -- Nullable: a task can be written down before it is anybody's.
  assignee_id uuid references public.employees(id) on delete set null,
  due_on      date,

  /**
   * Where the card sits in its column.
   *
   * Fractional on purpose. Dragging a card between two others writes ONE row
   * — the midpoint of its neighbours — instead of renumbering everything
   * below it, which on a shared board is how two people dragging at once
   * produce an order neither of them chose.
   */
  position    numeric not null default 0,

  estimate_minutes int check (estimate_minutes is null or estimate_minutes > 0),

  -- Stamped by trigger from `status`, never written by a client: they are the
  -- record of when the state actually changed, and a client that can set them
  -- can make any task look finished last week.
  started_at   timestamptz,
  completed_at timestamptz,

  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.tasks is
  'One thing to do, assigned to one employee. Its state is the board column '
  'it sits in.';

create index if not exists tasks_assignee_idx on public.tasks (assignee_id, status);
create index if not exists tasks_project_idx  on public.tasks (project_id, status);
create index if not exists tasks_board_idx    on public.tasks (status, position);
create index if not exists tasks_due_idx      on public.tasks (due_on)
  where status in ('todo', 'in_progress');

drop trigger if exists tasks_touch_updated_at on public.tasks;
create trigger tasks_touch_updated_at
  before update on public.tasks
  for each row execute function app.touch_updated_at();

-- ---------------------------------------------------------------------------
-- Time on a task
-- ---------------------------------------------------------------------------
create table if not exists public.task_sessions (
  id          uuid primary key default gen_random_uuid(),
  task_id     uuid not null references public.tasks(id) on delete cascade,
  employee_id uuid not null references public.employees(id) on delete restrict,

  started_at timestamptz not null default now(),
  -- Null means running. There can be at most one of those per person; see the
  -- partial unique index below.
  ended_at   timestamptz,

  /**
   * Whole minutes, generated.
   *
   * Generated rather than computed on read so a report can sum it, index it,
   * and mean the same thing everywhere. Null while the session is running,
   * which is what keeps a live timer out of every total until it stops.
   */
  minutes int generated always as (
    case when ended_at is null then null
         else greatest(0, floor(extract(epoch from (ended_at - started_at)) / 60))::int
    end) stored,

  -- A timer is evidence; a typed-in stretch of time is a claim. They are the
  -- same row with different provenance, and the difference is never lost.
  source text not null default 'timer' check (source in ('timer', 'manual')),
  status text not null default 'tracked'
         check (status in ('tracked', 'pending', 'approved', 'rejected')),

  note        text,
  reviewed_by uuid references auth.users(id) on delete set null,
  reviewed_at timestamptz,

  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  /*
   * `>=`, not `>`. A session started and stopped in the same second is a
   * misclick, and a misclick should be a zero-minute row somebody can delete,
   * not a constraint violation on screen.
   */
  constraint task_sessions_ends_after_start check (ended_at is null or ended_at >= started_at),
  -- Only a running timer may be open-ended. A manual entry with no end is not
  -- a claim about anything.
  constraint task_sessions_manual_is_closed check (source = 'timer' or ended_at is not null)
);

comment on table public.task_sessions is
  'A stretch of time on a task. Timed by the app or typed in and reviewed; '
  'either way it is one row and its provenance is on it.';

-- One clock per person. Without this, a forgotten timer on Monday and a new
-- one on Tuesday both run, and every hour after that is counted twice.
create unique index if not exists task_sessions_one_running
  on public.task_sessions (employee_id) where ended_at is null;

create index if not exists task_sessions_task_idx on public.task_sessions (task_id);
create index if not exists task_sessions_who_idx
  on public.task_sessions (employee_id, started_at desc);
create index if not exists task_sessions_review_idx
  on public.task_sessions (status) where status = 'pending';

drop trigger if exists task_sessions_touch_updated_at on public.task_sessions;
create trigger task_sessions_touch_updated_at
  before update on public.task_sessions
  for each row execute function app.touch_updated_at();

/**
 * Which sessions a total is allowed to include.
 *
 * A timed session counts because the app watched it happen. A typed-in one
 * counts only once somebody with `team.write` has agreed to it. Written once,
 * here, because "hours worked" appearing with two different definitions on two
 * screens is the fastest way to lose trust in both.
 */
create or replace function app.session_counts(p_status text)
returns boolean language sql immutable set search_path = '' as $$
  select p_status in ('tracked', 'approved')
$$;

-- ===========================================================================
-- The rails
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- A column change is a fact about when, not just what
-- ---------------------------------------------------------------------------
create or replace function app.guard_task()
returns trigger language plpgsql security definer set search_path = '' as $function$
declare
  v_manager boolean := app.can('team.write');
  v_me      uuid    := app.my_employee_id();
begin
  if tg_op = 'DELETE' then
    if not v_manager then
      raise exception 'only a manager can delete a task'
        using errcode = 'insufficient_privilege';
    end if;
    return old;
  end if;

  if tg_op = 'INSERT' then
    -- Anybody may write down their own to-do. Handing one to somebody else is
    -- a management act.
    if not v_manager and v_me is null then
      -- Said apart from the case below, because they are different problems.
      -- "You can only add tasks for yourself" is baffling advice to somebody
      -- who has no self here yet: their login was never put on the roster,
      -- and that is somebody else's to fix.
      raise exception 'your account is not on the work roster yet'
        using errcode = 'insufficient_privilege';
    end if;
    if not v_manager and new.assignee_id is distinct from v_me then
      raise exception 'you can only add tasks for yourself'
        using errcode = 'insufficient_privilege';
    end if;
  else
    /*
     * Working a task and managing it are different jobs.
     *
     * The assignee moves it across the board and reorders it, and that is all.
     * Without this, RLS — which cannot see columns — would let somebody hand
     * their own task to a colleague, push its due date out a month, or drop
     * its priority, and the board would still look tidy afterwards.
     */
    if not v_manager
       and (new.title            is distinct from old.title
         or new.project_id       is distinct from old.project_id
         or new.assignee_id      is distinct from old.assignee_id
         or new.due_on           is distinct from old.due_on
         or new.priority         is distinct from old.priority
         or new.estimate_minutes is distinct from old.estimate_minutes) then
      raise exception 'you can move your task, not reassign or re-scope it'
        using errcode = 'insufficient_privilege';
    end if;
  end if;

  -- The two timestamps follow the status, and only the status.
  if new.status = 'in_progress' then
    new.started_at := coalesce(old.started_at, new.started_at, now());
  end if;

  if new.status = 'done' then
    new.completed_at := coalesce(
      case when tg_op = 'UPDATE' and old.status = 'done' then old.completed_at end,
      now());
    new.started_at := coalesce(new.started_at, now());
  else
    -- Moved back out of Done: it is not finished, so it has no finish time.
    new.completed_at := null;
  end if;

  return new;
end;
$function$;

drop trigger if exists tasks_guard on public.tasks;
create trigger tasks_guard
  before insert or update or delete on public.tasks
  for each row execute function app.guard_task();

drop trigger if exists tasks_stamp_author on public.tasks;
create trigger tasks_stamp_author
  before insert on public.tasks
  for each row execute function app.stamp_created_by();

-- ---------------------------------------------------------------------------
-- Time is claimed by one person and agreed by another
-- ---------------------------------------------------------------------------
create or replace function app.guard_task_session()
returns trigger language plpgsql security definer set search_path = '' as $function$
declare
  v_manager boolean := app.can('team.write');
  v_me      uuid    := app.my_employee_id();
begin
  if tg_op = 'DELETE' then
    -- Your own, or a manager's call. A running timer is always yours to drop.
    if not v_manager and old.employee_id is distinct from v_me then
      raise exception 'that is not your time entry'
        using errcode = 'insufficient_privilege';
    end if;
    return old;
  end if;

  if tg_op = 'INSERT' then
    if not v_manager and new.employee_id is distinct from v_me then
      raise exception 'you can only log your own time'
        using errcode = 'insufficient_privilege';
    end if;

    /*
     * Typed-in time starts as a claim, and it cannot be self-approved.
     *
     * This is the whole point of the manual/timer split: without it, "hours
     * worked" is a number each person writes for themselves, and the report
     * built on it means nothing.
     */
    if new.source = 'manual' then
      new.status := 'pending';
    else
      new.status := 'tracked';
    end if;
    new.reviewed_by := null;
    new.reviewed_at := null;
    return new;
  end if;

  -- UPDATE.
  if not v_manager and old.employee_id is distinct from v_me then
    raise exception 'that is not your time entry' using errcode = 'insufficient_privilege';
  end if;

  -- Only a manager decides a claim, and only through review_time_entry, which
  -- is what stamps the reviewer.
  if new.status is distinct from old.status and not v_manager then
    raise exception 'only a manager can approve or reject time'
      using errcode = 'insufficient_privilege';
  end if;

  -- Re-typing the hours after they were agreed makes the agreement worthless.
  if old.status = 'approved' and not v_manager
     and (new.started_at is distinct from old.started_at
       or new.ended_at   is distinct from old.ended_at) then
    raise exception 'approved time cannot be changed'
      using errcode = 'restrict_violation';
  end if;

  return new;
end;
$function$;

drop trigger if exists task_sessions_guard on public.task_sessions;
create trigger task_sessions_guard
  before insert or update or delete on public.task_sessions
  for each row execute function app.guard_task_session();

drop trigger if exists task_sessions_stamp_author on public.task_sessions;
create trigger task_sessions_stamp_author
  before insert on public.task_sessions
  for each row execute function app.stamp_created_by();

-- ===========================================================================
-- Security
-- ===========================================================================
-- The read rule is the one thing here that differs from every other table in
-- this database: it is not a single permission but "everybody's, or mine".
do $do$
declare t text;
begin
  foreach t in array array['projects', 'tasks', 'task_sessions'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('alter table public.%I force row level security', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
    execute format('grant select, insert, update, delete on public.%I to authenticated', t);
    execute format('grant all on public.%I to service_role', t);
    execute format(
      'revoke truncate, references, trigger, maintain on public.%I from anon, authenticated', t);

    -- Anything left over from an earlier run. A stray permissive policy is a
    -- second, looser way in, and permissive policies OR together.
    execute format('drop policy if exists %I on public.%I', t || '_read', t);
    execute format('drop policy if exists %I on public.%I', t || '_write', t);
  end loop;
end $do$;

-- Projects are the vocabulary of the board: anybody who has a board has to be
-- able to read the list, or every card shows a blank tag. Creating one is a
-- management act.
create policy projects_read on public.projects
  for select to authenticated
  using (app.can('team.read') or app.can('tasks.read'));

create policy projects_write on public.projects
  for all to authenticated
  using (app.can('team.write'))
  with check (app.can('team.write'));

/*
 * A task is visible to the person it belongs to, the person who wrote it, and
 * anybody who may see the team.
 *
 * `created_by` is in there so a task you raised and handed on does not vanish
 * from your own view of it the moment you assign it.
 *
 * The write policy is row-level and therefore cannot say WHICH columns an
 * assignee may change — `app.guard_task` does that, and it is the rail that
 * stops somebody quietly reassigning their own work or pushing its due date.
 */
create policy tasks_read on public.tasks
  for select to authenticated
  using (
    app.can('team.read')
    or (app.can('tasks.read')
        and (assignee_id = app.my_employee_id() or created_by = auth.uid()))
  );

create policy tasks_write on public.tasks
  for all to authenticated
  using (
    app.can('team.write')
    or (app.can('tasks.write')
        and (assignee_id = app.my_employee_id() or created_by = auth.uid()))
  )
  with check (
    app.can('team.write')
    or (app.can('tasks.write')
        and (assignee_id = app.my_employee_id() or created_by = auth.uid()))
  );

create policy task_sessions_read on public.task_sessions
  for select to authenticated
  using (
    app.can('team.read')
    or (app.can('tasks.read') and employee_id = app.my_employee_id())
  );

create policy task_sessions_write on public.task_sessions
  for all to authenticated
  using (
    app.can('team.write')
    or (app.can('tasks.write') and employee_id = app.my_employee_id())
  )
  with check (
    app.can('team.write')
    or (app.can('tasks.write') and employee_id = app.my_employee_id())
  );

-- ===========================================================================
-- The lists the screens read
-- ===========================================================================
-- security_invoker on every one, set after the CREATE — `create or replace
-- view` discards reloptions, and losing it here would show every person the
-- whole team's board.

create or replace view public.v_projects as
select p.id, p.name, p.key, p.description, p.colour, p.is_active, p.sort_order,
       p.created_at, p.updated_at,
       coalesce(s.total, 0)        as tasks,
       coalesce(s.todo, 0)         as todo,
       coalesce(s.in_progress, 0)  as in_progress,
       coalesce(s.done, 0)         as done,
       coalesce(s.cancelled, 0)    as cancelled,
       -- Cancelled work is not "not done yet", so it leaves the denominator
       -- entirely rather than holding a project below 100% forever.
       case when coalesce(s.total, 0) - coalesce(s.cancelled, 0) > 0
            then round(100.0 * coalesce(s.done, 0)
                       / (coalesce(s.total, 0) - coalesce(s.cancelled, 0)))
            else 0 end             as percent_done,
       coalesce(s.overdue, 0)      as overdue,
       coalesce(m.minutes, 0)      as minutes
  from public.projects p
  left join lateral (
    select count(*)                                          as total,
           count(*) filter (where t.status = 'todo')          as todo,
           count(*) filter (where t.status = 'in_progress')   as in_progress,
           count(*) filter (where t.status = 'done')          as done,
           count(*) filter (where t.status = 'cancelled')     as cancelled,
           count(*) filter (where t.status in ('todo','in_progress')
                              and t.due_on < (now() at time zone 'Africa/Cairo')::date)
                                                              as overdue
      from public.tasks t where t.project_id = p.id
  ) s on true
  left join lateral (
    select sum(ts.minutes) as minutes
      from public.task_sessions ts
      join public.tasks t2 on t2.id = ts.task_id
     where t2.project_id = p.id and app.session_counts(ts.status)
  ) m on true;

alter view public.v_projects set (security_invoker = on);

create or replace view public.v_tasks as
select t.id, t.project_id, p.name as project_name, p.key as project_key,
       p.colour as project_colour,
       t.title, t.description, t.status, t.priority,
       t.assignee_id, e.full_name as assignee_name, e.job_title as assignee_role,
       t.due_on,
       -- "Late" is a Cairo-day question, like every other date in this system.
       (t.status in ('todo', 'in_progress')
        and t.due_on < (now() at time zone 'Africa/Cairo')::date) as is_overdue,
       t.position, t.estimate_minutes,
       t.started_at, t.completed_at, t.created_by, t.created_at, t.updated_at,
       coalesce(s.minutes, 0)   as minutes,
       coalesce(s.sessions, 0)  as sessions,
       s.running_since,
       (s.running_since is not null) as is_running,
       /**
        * WHOSE clock is running on this task.
        *
        * `is_running` is about the task — somebody is working on it, and that
        * is worth showing on a shared board. Start and Stop are about YOU, and
        * conflating the two put a Stop button in front of a person whose own
        * timer was somewhere else entirely.
        */
       s.running_employee_id
  from public.tasks t
  left join public.projects p on p.id = t.project_id
  left join app.team_members() e on e.id = t.assignee_id
  left join lateral (
    select sum(ts.minutes) filter (where app.session_counts(ts.status)) as minutes,
           count(*) filter (where app.session_counts(ts.status))        as sessions,
           max(ts.started_at) filter (where ts.ended_at is null)        as running_since,
           (array_agg(ts.employee_id) filter (where ts.ended_at is null))[1]
                                                                       as running_employee_id
      from public.task_sessions ts where ts.task_id = t.id
  ) s on true;

alter view public.v_tasks set (security_invoker = on);

create or replace view public.v_task_sessions as
select ts.id, ts.task_id, t.title as task_title,
       t.project_id, p.name as project_name, p.key as project_key,
       ts.employee_id, e.full_name as employee_name,
       ts.started_at, ts.ended_at, ts.minutes, ts.source, ts.status,
       app.session_counts(ts.status) as counts,
       -- The Cairo day this session belongs to, so a report can group by it
       -- without every caller re-deciding what "today" means.
       (ts.started_at at time zone 'Africa/Cairo')::date as day,
       ts.note, ts.reviewed_by, ts.reviewed_at, ts.created_at, ts.updated_at
  from public.task_sessions ts
  join public.tasks t on t.id = ts.task_id
  left join public.projects p on p.id = t.project_id
  left join app.team_members() e on e.id = ts.employee_id;

alter view public.v_task_sessions set (security_invoker = on);

/**
 * One row per person: what they are carrying and what they have done.
 *
 * The three windows are Cairo-relative and computed here rather than passed
 * in, so "today" cannot mean one thing on the dashboard and another in the
 * report. `minutes_today` against `daily_target_minutes` is the only ratio in
 * this view, and it exists because a raw "5h 12m" answers nothing without the
 * day it is a fraction of.
 */
create or replace view public.v_team_productivity as
select e.id, e.full_name, e.job_title, e.is_active, e.user_id,
       e.daily_target_minutes,
       coalesce(t.open, 0)         as open_tasks,
       coalesce(t.in_progress, 0)  as in_progress,
       coalesce(t.overdue, 0)      as overdue,
       coalesce(t.done_total, 0)   as done_total,
       coalesce(t.done_week, 0)    as done_week,
       coalesce(s.minutes_today, 0) as minutes_today,
       coalesce(s.minutes_week, 0)  as minutes_week,
       coalesce(s.minutes_month, 0) as minutes_month,
       coalesce(s.pending, 0)       as pending_reviews,
       s.last_activity_at,
       r.task_id                    as running_task_id,
       r.title                      as running_task_title,
       r.started_at                 as running_since
  from app.team_members() e
  left join lateral (
    select count(*) filter (where tk.status in ('todo', 'in_progress'))  as open,
           count(*) filter (where tk.status = 'in_progress')             as in_progress,
           count(*) filter (where tk.status in ('todo', 'in_progress')
                              and tk.due_on < (now() at time zone 'Africa/Cairo')::date)
                                                                         as overdue,
           count(*) filter (where tk.status = 'done')                    as done_total,
           count(*) filter (where tk.status = 'done'
                              and tk.completed_at >= app.cairo_week_start())
                                                                         as done_week
      from public.tasks tk where tk.assignee_id = e.id
  ) t on true
  left join lateral (
    select sum(ts.minutes) filter (
             where app.session_counts(ts.status)
               and (ts.started_at at time zone 'Africa/Cairo')::date
                   = (now() at time zone 'Africa/Cairo')::date)          as minutes_today,
           sum(ts.minutes) filter (
             where app.session_counts(ts.status)
               and ts.started_at >= app.cairo_week_start())
                                                                         as minutes_week,
           sum(ts.minutes) filter (
             where app.session_counts(ts.status)
               and ts.started_at >= app.cairo_month_start())
                                                                         as minutes_month,
           count(*) filter (where ts.status = 'pending')                 as pending,
           max(ts.started_at)                                            as last_activity_at
      from public.task_sessions ts where ts.employee_id = e.id
  ) s on true
  left join lateral (
    select ts.task_id, tk.title, ts.started_at
      from public.task_sessions ts
      join public.tasks tk on tk.id = ts.task_id
     where ts.employee_id = e.id and ts.ended_at is null
     limit 1
  ) r on true
 /*
  * Everybody's, or just mine.
  *
  * The rows in the lateral joins are already filtered by RLS, so without this
  * line somebody holding only `tasks.read` would see the whole roster with
  * every figure zeroed — which leaks the shape of the team while pretending
  * not to. Their own row stays, because "how is my day going" is a question
  * about themselves and needs no permission over anybody else.
  */
 where app.can('team.read') or e.id = app.my_employee_id();

alter view public.v_team_productivity set (security_invoker = on);

do $$
declare t text;
begin
  foreach t in array array[
    'v_projects', 'v_tasks', 'v_task_sessions', 'v_team_productivity'
  ] loop
    execute format('revoke all on public.%I from anon', t);
    execute format('grant select on public.%I to authenticated', t);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- The employee list gains the length of a working day
-- ---------------------------------------------------------------------------
-- Re-declared rather than altered: a view cannot gain a column any other way.
-- The new column goes on the END, because every existing column of a replaced
-- view must keep its name, its type and its position — and `security_invoker`
-- has to be set again afterwards, because CREATE OR REPLACE discards it.
create or replace view public.v_employees as
select e.id, e.full_name, e.job_title, e.phone, e.email,
       e.user_id,
       (e.user_id is not null)                   as has_login,
       e.base_salary, e.wallet_id, w.name        as wallet_name,
       e.hired_on, e.ended_on, e.is_active, e.note,
       e.created_at, e.updated_at,
       r.name                                    as role_name,
       r.name_en                                 as role_name_en,
       coalesce(p.payslips, 0)                   as payslips,
       coalesce(p.paid_count, 0)                 as paid_count,
       coalesce(p.paid_total, 0)::numeric(14,2)  as paid_total,
       p.last_paid_at,
       e.daily_target_minutes
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

-- ===========================================================================
-- Assertions
-- ===========================================================================
do $$
declare missing text;
begin
  select string_agg(c.relname, ', ') into missing
    from pg_class c join pg_namespace ns on ns.oid = c.relnamespace
   where ns.nspname = 'public' and c.relkind = 'v'
     and not coalesce(
       (select option_value from pg_options_to_table(c.reloptions)
         where option_name = 'security_invoker')::boolean, false);
  if missing is not null then
    raise exception 'views without security_invoker: %', missing;
  end if;

  select string_agg(c.relname, ', ') into missing
    from pg_class c join pg_namespace ns on ns.oid = c.relnamespace
   where ns.nspname = 'public' and c.relkind = 'r' and c.relrowsecurity
     and not exists (select 1 from pg_policies p
                      where p.schemaname = 'public' and p.tablename = c.relname);
  if missing is not null then
    raise exception 'tables with RLS and no policy: %', missing;
  end if;
end $$;
