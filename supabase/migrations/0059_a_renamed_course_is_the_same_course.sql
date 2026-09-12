-- ===========================================================================
-- 0059 — a renamed course is the same course
-- ===========================================================================
-- ukkera sent transfer 857 for course 2224 spelled
-- "الكورس التأسيسي -Introduction course". We already held course 2224 under
-- the spelling it arrived with four days earlier, "Introduction course -
-- الكورس التأسيسي". The projection looked the course up BY NAME:
--
--     insert into public.courses (name, ukkera_course_id) values (…)
--     on conflict (name_key) do update …
--
-- A new name is not a conflict on name_key, so Postgres went to insert a
-- second course — carrying the same ukkera_course_id — and courses_ukkera_id_uniq
-- stopped it. The exception took the whole projection down with it: no course,
-- no package, no enrolment. Twelve sweeps later the event was out of attempts
-- and the student sat in the list with a paid subscription that named nothing,
-- no level, no university, no track. Only Kashier's side of the purchase had
-- landed, and Kashier cannot see a course.
--
-- The rename was the trigger; the fault is that identity was read off a label.
-- ukkera gives every course a number and every purchase a transfer id. Those
-- are the identity. The name is a description, and descriptions get edited.
--
-- So: resolution moves into two functions that look for the thing by what it
-- IS, fall back to what it is CALLED, adopt what is already there rather than
-- inventing a rival, and cannot raise on a key they just failed to find — the
-- races included. The same drift had already left two enrolments on a package
-- with no course (ukkera's older payloads carried no course at all) and a
-- duplicate package beside it; both are repaired below.
--
-- Also here: a failed ukkera event now appears on /health. The card there only
-- ever read kashier_events_raw, which is the reason this sat unseen for a day.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. The spelling ukkera last used, kept beside the one we hold
-- ---------------------------------------------------------------------------
-- The stored name is not overwritten on a rename: it is what the reports group
-- by, what the level and university were parsed out of, and what someone may
-- have tidied by hand. But a divergence that is invisible is a divergence
-- nobody reconciles, so it is written down — the same bargain as
-- courses.university_label.
alter table public.courses
  add column if not exists ukkera_course_name text;

comment on column public.courses.ukkera_course_name is
  'The course title exactly as ukkera last spelled it. Kept beside the name we '
  'hold so a rename on their side is visible instead of silent — the course is '
  'identified by ukkera_course_id, never by either spelling.';

-- ---------------------------------------------------------------------------
-- 2. Resolving a course
-- ---------------------------------------------------------------------------
create or replace function app.resolve_course(p_name text, p_ukkera_id text)
returns uuid language plpgsql security definer set search_path = '' as $function$
declare
  v_key text := app.text_key(p_name);
  v_id  uuid;
begin
  if p_ukkera_id is null and v_key is null then return null; end if;

  -- Identity first. A course keeps its number across every rename.
  if p_ukkera_id is not null then
    select id into v_id from public.courses where ukkera_course_id = p_ukkera_id;
  end if;

  -- Then the name — app.text_key, not the generated name_key: that one is a
  -- bare upper(btrim()) and would miss "Asyut  - 2027" against "Asyut - 2027".
  if v_id is null and v_key is not null then
    select id into v_id
      from public.courses
     where app.text_key(name) = v_key
     order by created_at
     limit 1;
  end if;

  -- Neither: it is new. A number with no name cannot become a course — there
  -- would be nothing to call it — so the enrolment goes on without one.
  if v_id is null then
    if v_key is null then return null; end if;
    begin
      insert into public.courses (name, ukkera_course_id, ukkera_course_name)
      values (p_name, p_ukkera_id, p_name)
      returning id into v_id;
    exception when unique_violation then
      -- A concurrent delivery of the same purchase got there first. Whatever
      -- it wrote is the answer; this must not be the exception that loses an
      -- enrolment.
      select id into v_id
        from public.courses
       where (p_ukkera_id is not null and ukkera_course_id = p_ukkera_id)
          or app.text_key(name) = v_key
       order by (ukkera_course_id is not distinct from p_ukkera_id) desc, created_at
       limit 1;
      if v_id is null then raise; end if;
    end;
    return v_id;
  end if;

  -- Found. Adopt the number if the row has none, and record the spelling.
  -- Never the name itself: courses.university_id/track_id/level are parsed
  -- from it, and re-parsing on someone else's edit is not this function's call.
  begin
    update public.courses
       set ukkera_course_id   = coalesce(ukkera_course_id, p_ukkera_id),
           ukkera_course_name = coalesce(p_name, ukkera_course_name),
           updated_at         = now()
     where id = v_id
       and (   (ukkera_course_id is null and p_ukkera_id is not null)
            or (p_name is not null and ukkera_course_name is distinct from p_name));
  exception when unique_violation then
    null;  -- another row already holds that number; the link is not worth the event
  end;

  return v_id;
end;
$function$;

comment on function app.resolve_course is
  'The course ukkera means, by number first and title second. Adopts what is '
  'already stored instead of inserting a rival, and never raises on a key it '
  'just looked for and did not find.';

-- ---------------------------------------------------------------------------
-- 3. Resolving a package
-- ---------------------------------------------------------------------------
-- A package is only unique within its course — "اشتراك ( الكورس كاملا)" is
-- sold on four of them. Two consequences, both learned the hard way:
--   * with a course, an orphan of the same name is THIS package, left behind
--     by the payloads that carried no course. Adopt it; do not shelve a second
--     copy beside it and split one package's subscriptions across two rows.
--   * without a course, a shared name identifies nothing. Guessing would enrol
--     the student on somebody else's course, so only a name held by exactly one
--     package is allowed to answer.
create or replace function app.resolve_package(p_course uuid, p_name text)
returns uuid language plpgsql security definer set search_path = '' as $function$
declare
  v_key   text := app.text_key(p_name);
  v_id    uuid;
  v_count int;
begin
  if v_key is null then return null; end if;

  select id into v_id
    from public.packages
   where course_id is not distinct from p_course
     and app.text_key(name) = v_key
   order by created_at
   limit 1;
  if v_id is not null then return v_id; end if;

  if p_course is not null then
    select id into v_id
      from public.packages
     where course_id is null and app.text_key(name) = v_key
     order by created_at
     limit 1;

    if v_id is not null then
      begin
        update public.packages
           set course_id = p_course, updated_at = now()
         where id = v_id;
        return v_id;
      exception when unique_violation then
        select id into v_id
          from public.packages
         where course_id = p_course and app.text_key(name) = v_key
         order by created_at
         limit 1;
        if v_id is not null then return v_id; end if;
      end;
    end if;
  else
    select count(*) into v_count
      from public.packages where app.text_key(name) = v_key;
    if v_count = 1 then
      select id into v_id
        from public.packages where app.text_key(name) = v_key;
      return v_id;
    end if;
  end if;

  begin
    insert into public.packages (course_id, name)
    values (p_course, p_name)
    returning id into v_id;
  exception when unique_violation then
    select id into v_id
      from public.packages
     where course_id is not distinct from p_course
       and app.text_key(name) = v_key
     order by created_at
     limit 1;
    if v_id is null then raise; end if;
  end;

  return v_id;
end;
$function$;

comment on function app.resolve_package is
  'The package ukkera means, within the course it was sold on. Adopts the '
  'course-less rows older payloads left behind, and refuses to guess a course '
  'from a package name several courses share.';

-- ---------------------------------------------------------------------------
-- 4. The projection, with the catalogue read through the two resolvers
-- ---------------------------------------------------------------------------
-- Unchanged from 0031 except for the course and package blocks, and one line:
-- when ukkera names a package but no course, the package's own course answers.
create or replace function app.project_ukkera_event(p_raw public.ukkera_events_raw)
returns void language plpgsql security definer set search_path = '' as $function$
declare
  p             jsonb := p_raw.payload;
  v_event       text  := lower(btrim(coalesce(p ->> 'event', '')));
  v_transfer    text;
  v_name        text;
  v_phone       text;
  v_phone_n     text;
  v_email       text;
  v_course      text;
  v_course_ext  text;
  v_package     text;
  v_amount      numeric;
  v_at          timestamptz;
  v_date        date;
  v_student     uuid;
  v_course_id   uuid;
  v_package_id  uuid;
  v_pkg         public.packages;
  v_plan        uuid;
  v_sub         uuid;
  v_match_count int;
begin
  -- A connectivity check from ukkera's "test" button carries no real order
  -- (transfer_id is 0). Record it, acknowledge it, but never let it invent a
  -- student or a subscription.
  if v_event = 'test' then
    raise exception 'IGNORE: ukkera connectivity test event (no real order)';
  end if;

  v_transfer := nullif(btrim(coalesce(
                  p ->> 'transfer_id', p ->> 'order_id', p ->> 'orderId',
                  p ->> 'transaction_id', p ->> 'id', '')), '');
  if v_transfer = '0' then v_transfer := null; end if;
  if v_transfer is null then
    raise exception 'IGNORE: ukkera payload has no usable order identifier';
  end if;

  v_name       := nullif(btrim(coalesce(p ->> 'student_name', p ->> 'name', '')), '');
  v_phone      := coalesce(p ->> 'phone', p ->> 'student_phone');
  v_phone_n    := app.normalize_phone(v_phone);
  v_email      := nullif(btrim(coalesce(p ->> 'student_email', p ->> 'email', '')), '');
  v_course     := nullif(btrim(coalesce(p ->> 'course_name', p ->> 'course', '')), '');
  v_course_ext := nullif(btrim(coalesce(p ->> 'course_id', '')), '');
  if v_course_ext = '0' then v_course_ext := null; end if;
  v_package    := nullif(btrim(coalesce(p ->> 'package_name', p ->> 'package', '')), '');
  v_amount     := app.to_numeric(p ->> 'amount');

  -- The full instant, not just the day: it is the only thing that tells this
  -- purchase apart from the same student's next one when linking to Kashier.
  begin
    v_at := (coalesce(p ->> 'date', p ->> 'payment_date'))::timestamptz;
  exception when others then
    v_at := null;
  end;
  v_date := (v_at at time zone 'Africa/Cairo')::date;

  -- ---------------------------------------------------------- course/package
  v_course_id  := app.resolve_course(v_course, v_course_ext);
  v_package_id := app.resolve_package(v_course_id, v_package);

  if v_package_id is not null then
    select * into v_pkg from public.packages where id = v_package_id;
    -- ukkera's older payloads named the package and not the course. The
    -- package knows which course it is sold on; that is the same answer.
    v_course_id := coalesce(v_course_id, v_pkg.course_id);
  end if;

  -- ----------------------------------------------------------------- student
  if v_phone_n is not null then
    select id into v_student
      from public.students
     where phone_normalized = v_phone_n
     order by (app.text_key(name) = app.text_key(v_name)) desc, created_at asc
     limit 1;
  end if;

  if v_student is null and v_name is not null then
    select count(*) into v_match_count
      from public.students where app.text_key(name) = app.text_key(v_name);
    if v_match_count = 1 then
      select id into v_student
        from public.students where app.text_key(name) = app.text_key(v_name) limit 1;
    end if;
  end if;

  if v_student is null and v_name is not null then
    insert into public.students (name, phone, email)
    values (v_name, v_phone, v_email)
    returning id into v_student;
  elsif v_student is not null then
    update public.students
       set phone = coalesce(phone, v_phone),
           email = coalesce(email, v_email),
           name  = case when btrim(coalesce(name, '')) = '' then coalesce(v_name, name) else name end
     where id = v_student;
  end if;

  -- -------------------------------------------------------------------- plan
  if v_pkg.kind = 'installment' and v_student is not null then
    select id into v_plan
      from public.installment_plans
     where student_id = v_student
       and course_id is not distinct from v_course_id
       and closed_at is null
     limit 1;

    if v_plan is null then
      insert into public.installment_plans (
        student_id, course_id, package_id, total_due, installment_count
      ) values (
        v_student, v_course_id, v_package_id,
        -- The course price if it is known: set explicitly on the package, or
        -- inferred from one instalment times the count. Left NULL otherwise —
        -- an invented total becomes a debt the student does not owe.
        coalesce(v_pkg.total_price, v_pkg.price * v_pkg.installment_count),
        greatest(v_pkg.installment_count, 1)
      )
      returning id into v_plan;
    end if;
  end if;

  -- ------------------------------------------------------------ subscription
  select id into v_sub from public.subscriptions where ukkera_transfer_id = v_transfer;

  if v_sub is null then
    -- Kashier may have written this purchase already, from the payment side.
    v_sub := app.find_sibling_subscription(v_student, v_amount, v_at, 'ukkera');
  end if;

  if v_sub is not null then
    update public.subscriptions s
       set ukkera_transfer_id = v_transfer,
           ukkera_transfer_at = coalesce(v_at, s.ukkera_transfer_at),
           student_id         = coalesce(s.student_id, v_student),
           course_id          = coalesce(v_course_id, s.course_id),
           package_id         = coalesce(v_package_id, s.package_id),
           amount             = coalesce(v_amount, s.amount),
           payment_date       = coalesce(s.payment_date, v_date),
           plan_id            = coalesce(v_plan, s.plan_id),
           plan_kind          = coalesce(v_pkg.kind, s.plan_kind),
           source             = case when s.source = 'kashier_metadata'
                                     then 'ukkera_webhook' else s.source end,
           updated_at         = now()
     where s.id = v_sub;
    return;
  end if;

  insert into public.subscriptions (
    student_id, course_id, package_id, order_id, amount, payment_date, source,
    ukkera_transfer_id, ukkera_transfer_at, plan_id, plan_kind
  ) values (
    v_student, v_course_id, v_package_id, v_transfer, v_amount, v_date, 'ukkera_webhook',
    v_transfer, v_at, v_plan, coalesce(v_pkg.kind, 'other')
  )
  on conflict (order_key) do update set
    student_id         = coalesce(public.subscriptions.student_id, excluded.student_id),
    course_id          = coalesce(excluded.course_id, public.subscriptions.course_id),
    package_id         = coalesce(excluded.package_id, public.subscriptions.package_id),
    amount             = coalesce(excluded.amount, public.subscriptions.amount),
    payment_date       = coalesce(excluded.payment_date, public.subscriptions.payment_date),
    ukkera_transfer_id = coalesce(public.subscriptions.ukkera_transfer_id, excluded.ukkera_transfer_id),
    ukkera_transfer_at = coalesce(public.subscriptions.ukkera_transfer_at, excluded.ukkera_transfer_at),
    plan_id            = coalesce(public.subscriptions.plan_id, excluded.plan_id),
    plan_kind          = excluded.plan_kind,
    updated_at         = now();
end;
$function$;

-- ---------------------------------------------------------------------------
-- 5. Repair — the rows the old resolution left behind
-- ---------------------------------------------------------------------------
-- 5a. One package, two rows. ukkera's first payloads named a package and no
--     course, so an orphan was stored; when the course finally arrived, the
--     lookup asked for a package on THAT course, found none, and shelved a
--     second copy beside the first. The older row is the keeper — it is the one
--     the earlier enrolments already point at — and it takes the course.
--     A name that leads to more than one course is left alone: merging those
--     would be a guess, and the guess would move somebody's enrolment.
do $$
declare
  o        record;
  v_course uuid;
  v_keep   uuid;
  v_drop   uuid;
  v_n      int;
begin
  for o in select id, name from public.packages where course_id is null loop
    -- a previous iteration may have adopted this very row
    continue when not exists (
      select 1 from public.packages where id = o.id and course_id is null);

    select count(distinct course_id) into v_n
      from public.packages
     where course_id is not null and app.text_key(name) = app.text_key(o.name);
    continue when v_n <> 1;

    select course_id into v_course
      from public.packages
     where course_id is not null and app.text_key(name) = app.text_key(o.name)
     limit 1;

    select id into v_keep
      from public.packages
     where app.text_key(name) = app.text_key(o.name)
       and (course_id is null or course_id = v_course)
     order by created_at
     limit 1;

    for v_drop in
      select id from public.packages
       where app.text_key(name) = app.text_key(o.name)
         and (course_id is null or course_id = v_course)
         and id <> v_keep
    loop
      update public.subscriptions
         set package_id = v_keep, updated_at = now() where package_id = v_drop;
      update public.installment_plans
         set package_id = v_keep where package_id = v_drop;
      -- Prices are set by hand; whichever copy carries one keeps it.
      update public.packages k
         set price       = coalesce(k.price, d.price),
             total_price = coalesce(k.total_price, d.total_price)
        from public.packages d
       where k.id = v_keep and d.id = v_drop;
      delete from public.packages where id = v_drop;
    end loop;

    update public.packages
       set course_id = v_course, updated_at = now()
     where id = v_keep and course_id is null;
  end loop;
end $$;

-- 5b. An enrolment whose package knows its course, but which never learned it.
--     The trigger on subscriptions re-reads the student's level, university and
--     track from here.
update public.subscriptions s
   set course_id = p.course_id, updated_at = now()
  from public.packages p
 where p.id = s.package_id
   and s.course_id is null
   and p.course_id is not null;

-- 5c. Replay. The sweeper stops at twelve attempts and event 857 had spent all
--     twelve on a bug that is now gone, so the counter goes back to zero and
--     both pipelines are swept.
update public.ukkera_events_raw  set process_attempts = 0 where state = 'failed';
update public.kashier_events_raw set process_attempts = 0 where state = 'failed';
do $$ begin perform app.sweep_failed_events(500, 12); end $$;

-- ---------------------------------------------------------------------------
-- 6. A failed event is visible whichever pipeline dropped it
-- ---------------------------------------------------------------------------
-- /health lists failed events from kashier_events_raw alone. The ukkera
-- failure that stranded this purchase was on the screen only as a number in a
-- counter, and a number in a counter is not a thing anybody opens.
create or replace view public.v_failed_events as
select 'kashier' as pipeline,
       e.id,
       e.mode::text                                    as mode,
       e.event,
       nullif(btrim(coalesce(e.payload #>> '{data,merchantOrderId}', '')), '') as subject,
       e.received_at, e.process_attempts, e.process_error
  from public.kashier_events_raw e
 where e.state = 'failed'
union all
select 'ukkera',
       e.id,
       null,
       nullif(btrim(coalesce(e.payload ->> 'event', '')), ''),
       nullif(btrim(concat_ws(' · ',
         nullif(btrim(coalesce(e.payload ->> 'student_name', '')), ''),
         nullif(btrim(coalesce(e.payload ->> 'transfer_id', '')), ''))), ''),
       e.received_at, e.process_attempts, e.process_error
  from public.ukkera_events_raw e
 where e.state = 'failed';

alter view public.v_failed_events set (security_invoker = on);
grant select on public.v_failed_events to authenticated, service_role;

comment on view public.v_failed_events is
  'Every webhook delivery whose projection failed, from either pipeline, with '
  'enough of the payload to say whose purchase it was.';
