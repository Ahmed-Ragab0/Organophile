-- 0010_ukkera_real_payload_shape.sql
--
-- The real ukkera payload, captured from a live "Test Webhook" fire, differs
-- from the field names in the project brief:
--
--   brief          actual
--   -----          ------
--   phone       -> student_phone
--   payment_date-> date
--   course      -> (absent)      but package_name IS present
--   order_id    -> (absent)      transfer_id instead
--                                plus student_email and an `event` field
--
--   {"date":"2026-09-07T12:05:42+00:00","event":"test","amount":100,
--    "transfer_id":0,"package_name":"Sample Package","student_name":"Test Student",
--    "student_email":"test@example.com","student_phone":"+201000000000"}
--
-- Notably this contradicts the brief's assumption that package data could not
-- arrive by webhook. It can, so packages are now populated from it.
--
-- Every field is read through a coalesce over both spellings: the captured
-- sample is a synthetic `event: "test"` fire, and the real payment payload may
-- yet use the names the brief documented. Accepting both costs nothing and
-- removes a whole class of cutover failure.

create or replace function app.project_ukkera_event(p_raw public.ukkera_events_raw)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  p            jsonb := p_raw.payload;
  v_event      text  := lower(btrim(coalesce(p ->> 'event', '')));
  v_order_id   text;
  v_name       text;
  v_phone      text;
  v_phone_n    text;
  v_email      text;
  v_course     text;
  v_package    text;
  v_amount     numeric;
  v_date       date;
  v_student    uuid;
  v_course_id  uuid;
  v_package_id uuid;
  v_match_count int;
begin
  -- A connectivity check from ukkera's "test" button carries no real order
  -- (transfer_id is 0). Record it, acknowledge it, but never let it invent a
  -- student or a subscription.
  if v_event = 'test' then
    raise exception 'IGNORE: ukkera connectivity test event (no real order)';
  end if;

  v_order_id := nullif(btrim(coalesce(
                  p ->> 'order_id', p ->> 'orderId', p ->> 'transfer_id',
                  p ->> 'transaction_id', p ->> 'id', '')), '');
  -- transfer_id is 0 on synthetic fires; treat it as absent.
  if v_order_id = '0' then v_order_id := null; end if;

  if v_order_id is null then
    raise exception 'IGNORE: ukkera payload has no usable order identifier';
  end if;

  v_name    := nullif(btrim(coalesce(p ->> 'student_name', p ->> 'name', '')), '');
  v_phone   := coalesce(p ->> 'phone', p ->> 'student_phone');
  v_phone_n := app.normalize_phone(v_phone);
  v_email   := nullif(btrim(coalesce(p ->> 'student_email', p ->> 'email', '')), '');
  v_course  := nullif(btrim(coalesce(p ->> 'course', p ->> 'course_name', '')), '');
  v_package := nullif(btrim(coalesce(p ->> 'package_name', p ->> 'package', '')), '');
  v_amount  := app.to_numeric(p ->> 'amount');

  begin
    v_date := (coalesce(p ->> 'payment_date', p ->> 'date'))::date;
  exception when others then
    v_date := null;
  end;

  if v_course is not null then
    insert into public.courses (name) values (v_course)
    on conflict (name_key) do update set updated_at = now()
    returning id into v_course_id;
  end if;

  -- Lookup-then-insert rather than ON CONFLICT: the unique key is
  -- (course_id, name_key) and a NULL course_id would defeat conflict
  -- inference, silently creating a duplicate package per delivery.
  if v_package is not null then
    select id into v_package_id
      from public.packages
     where name_key = upper(btrim(v_package))
       and course_id is not distinct from v_course_id
     limit 1;

    if v_package_id is null then
      insert into public.packages (course_id, name)
      values (v_course_id, v_package)
      returning id into v_package_id;
    end if;
  end if;

  if v_phone_n is not null then
    select id into v_student
      from public.students
     where phone_normalized = v_phone_n
     order by (upper(btrim(name)) = upper(btrim(coalesce(v_name, '')))) desc, created_at asc
     limit 1;
  end if;

  if v_student is null and v_name is not null then
    select count(*) into v_match_count
      from public.students
     where upper(btrim(name)) = upper(btrim(v_name));
    if v_match_count = 1 then
      select id into v_student
        from public.students
       where upper(btrim(name)) = upper(btrim(v_name))
       limit 1;
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

  insert into public.subscriptions (
    student_id, course_id, package_id, order_id, amount, payment_date, source
  ) values (
    v_student, v_course_id, v_package_id, v_order_id, v_amount, v_date, 'ukkera_webhook'
  )
  on conflict (order_key) do update set
    student_id   = coalesce(public.subscriptions.student_id, excluded.student_id),
    course_id    = coalesce(excluded.course_id, public.subscriptions.course_id),
    package_id   = coalesce(excluded.package_id, public.subscriptions.package_id),
    amount       = coalesce(excluded.amount, public.subscriptions.amount),
    payment_date = coalesce(excluded.payment_date, public.subscriptions.payment_date),
    updated_at   = now();
end;
$$;
