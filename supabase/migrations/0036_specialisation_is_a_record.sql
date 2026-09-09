-- 0036 — the specialisation becomes a record, and a student can carry one.
--
-- The university has been a real row since 0015. The specialisation never was:
-- `courses.track` is a word the title parser produced ('Clinical', 'Pharm D')
-- and nothing could point at it. So it could be read, but not chosen, renamed,
-- corrected, or attached to anyone. A student had no specialisation at all.
--
-- Three things change here.
--
--   1. `tracks` is a table, shaped exactly like `universities`, with the same
--      spelling-alias mechanism — one row per specialisation no matter how
--      ukkera writes it.
--   2. Students carry `university_id` and `track_id`, filled from the courses
--      they bought when those agree, and owned by the admin the moment the
--      admin touches them.
--   3. Renaming a university stops forking it. The alias table remembered a
--      SPELLING; the next delivery carrying the old spelling would resolve to
--      the old display name, fail to find it, and insert a second university.
--      Aliases now remember the id.

-- ---------------------------------------------------------------------------
-- 1. The specialisation, as a record
-- ---------------------------------------------------------------------------
create table if not exists public.tracks (
  id         uuid primary key default gen_random_uuid(),
  name       text not null check (btrim(name) <> ''),
  name_key   text generated always as (upper(btrim(name))) stored,
  is_active  boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint tracks_name_uniq unique (name_key)
);

comment on table public.tracks is
  'التخصصات — Clinical, Pharm D and the rest, as rows rather than as words '
  'left inside a course title.';

drop trigger if exists tracks_touch_updated_at on public.tracks;
create trigger tracks_touch_updated_at before update on public.tracks
  for each row execute function app.touch_updated_at();

alter table public.tracks enable row level security;
alter table public.tracks force  row level security;
revoke all on public.tracks from anon;
grant select, insert, update, delete on public.tracks to authenticated;
grant all on public.tracks to service_role;

drop policy if exists tracks_admin_all on public.tracks;
create policy tracks_admin_all on public.tracks
  for all to authenticated using (app.is_admin()) with check (app.is_admin());

-- One specialisation, many spellings — the same problem the universities had,
-- and the same answer.
create table if not exists public.track_aliases (
  alias_key    text primary key,
  display_name text not null,
  track_id     uuid references public.tracks(id) on delete set null,
  created_at   timestamptz not null default now()
);

alter table public.track_aliases enable row level security;
grant select on public.track_aliases to authenticated;
grant all    on public.track_aliases to service_role;

drop policy if exists track_aliases_read on public.track_aliases;
create policy track_aliases_read on public.track_aliases
  for select to authenticated using (app.is_admin());
drop policy if exists track_aliases_write on public.track_aliases;
create policy track_aliases_write on public.track_aliases
  for all to authenticated using (app.is_admin()) with check (app.is_admin());

-- The four this business actually teaches, named the way the screens are named.
insert into public.tracks (name) values
  ('إكلينيكال'), ('فارم دي'), ('صناعية'), ('تكنولوجيا حيوية')
on conflict (name_key) do nothing;

insert into public.track_aliases (alias_key, display_name) values
  ('CLINICAL', 'إكلينيكال'), ('CLINICAL PHARMACY', 'إكلينيكال'),
  ('CLINICAL PHARMACIST', 'إكلينيكال'),
  ('اكلينيكال', 'إكلينيكال'), ('إكلينيكال', 'إكلينيكال'), ('كلينيكال', 'إكلينيكال'),
  ('PHARM D', 'فارم دي'), ('PHARMD', 'فارم دي'), ('PHARM-D', 'فارم دي'),
  ('PHARM.D', 'فارم دي'), ('DOCTOR OF PHARMACY', 'فارم دي'),
  ('فارم دي', 'فارم دي'), ('فارمد', 'فارم دي'),
  ('INDUSTRIAL', 'صناعية'), ('INDUSTRIAL PHARMACY', 'صناعية'),
  ('صناعية', 'صناعية'), ('صناعي', 'صناعية'),
  ('BIOTECHNOLOGY', 'تكنولوجيا حيوية'), ('BIOTECH', 'تكنولوجيا حيوية'),
  ('حيوية', 'تكنولوجيا حيوية'), ('تكنولوجيا حيوية', 'تكنولوجيا حيوية')
on conflict (alias_key) do nothing;

-- Bind the seeded spellings to the rows they name, so a later rename of the
-- specialisation keeps every spelling attached to it.
update public.track_aliases a
   set track_id = tr.id
  from public.tracks tr
 where a.track_id is null and tr.name_key = app.text_key(a.display_name);

-- ---------------------------------------------------------------------------
-- 2. Aliases remember the row, not the spelling of its name
--
-- Before this, renaming a university broke every alias pointing at it: the
-- alias stored a display name, the resolver looked that name up, found nothing
-- after the rename, and inserted a SECOND university. The rename would have
-- looked fine right up until the next payment arrived.
-- ---------------------------------------------------------------------------
alter table public.university_aliases
  add column if not exists university_id uuid references public.universities(id)
      on delete set null;

update public.university_aliases a
   set university_id = u.id
  from public.universities u
 where a.university_id is null
   and u.name_key = app.text_key(a.display_name);

create or replace function app.resolve_university(p_label text)
returns uuid language plpgsql security definer set search_path = '' as $function$
declare
  v_key     text := app.text_key(p_label);
  v_display text;
  v_id      uuid;
begin
  if v_key is null then return null; end if;

  select display_name, university_id into v_display, v_id
    from public.university_aliases where alias_key = v_key;

  -- A remembered id beats a remembered spelling. This is the whole point:
  -- renaming a university must not fork it the next time ukkera sends the old
  -- name.
  if v_id is not null
     and exists (select 1 from public.universities where id = v_id) then
    return v_id;
  end if;

  -- Unknown spelling: keep it exactly as written, so the next delivery with
  -- the same spelling lands on the same row.
  v_display := coalesce(v_display, btrim(p_label));

  select id into v_id from public.universities
   where name_key = app.text_key(v_display) limit 1;
  if v_id is null then
    insert into public.universities (name) values (v_display)
    on conflict (name_key) do update set updated_at = now()
    returning id into v_id;
  end if;

  insert into public.university_aliases (alias_key, display_name, university_id)
  values (v_key, v_display, v_id)
  on conflict (alias_key) do update set university_id = excluded.university_id
   where university_aliases.university_id is null;

  return v_id;
end;
$function$;

create or replace function app.resolve_track(p_label text)
returns uuid language plpgsql security definer set search_path = '' as $function$
declare
  v_key     text := app.text_key(p_label);
  v_display text;
  v_id      uuid;
begin
  if v_key is null then return null; end if;

  select display_name, track_id into v_display, v_id
    from public.track_aliases where alias_key = v_key;

  if v_id is not null
     and exists (select 1 from public.tracks where id = v_id) then
    return v_id;
  end if;

  v_display := coalesce(v_display, btrim(p_label));

  select id into v_id from public.tracks
   where name_key = app.text_key(v_display) limit 1;
  if v_id is null then
    insert into public.tracks (name) values (v_display)
    on conflict (name_key) do update set updated_at = now()
    returning id into v_id;
  end if;

  insert into public.track_aliases (alias_key, display_name, track_id)
  values (v_key, v_display, v_id)
  on conflict (alias_key) do update set track_id = excluded.track_id
   where track_aliases.track_id is null;

  return v_id;
end;
$function$;

comment on function app.resolve_track is
  'The one place a spelling of a specialisation is bound to a row. Learns '
  'unseen spellings, and remembers the row by id so a rename keeps them.';

-- ---------------------------------------------------------------------------
-- 3. Courses and students point at both
-- ---------------------------------------------------------------------------
alter table public.courses
  add column if not exists track_id uuid references public.tracks(id) on delete set null;

alter table public.students
  add column if not exists track_id uuid references public.tracks(id) on delete set null,
  add column if not exists classification_locked boolean not null default false;

comment on column public.courses.track is
  'The specialisation exactly as the title spelled it, kept beside track_id '
  'the way university_label is kept beside university_id.';
comment on column public.students.classification_locked is
  'True once an admin has set the university or specialisation by hand. From '
  'then on the automatic classifier leaves this student alone — including when '
  'the admin cleared a field on purpose.';

create index if not exists courses_track_idx  on public.courses  (track_id);
create index if not exists students_track_idx on public.students (track_id);

create or replace function app.apply_course_name_parts()
returns trigger language plpgsql security definer set search_path = '' as $function$
declare
  a jsonb := app.parse_course_name(new.name);
begin
  new.subject          := a ->> 'subject';
  new.level            := (a ->> 'level')::int;
  new.section          := a ->> 'section';
  new.class_year       := (a ->> 'class_year')::int;
  new.track            := a ->> 'track';
  new.university_label := a ->> 'university';

  -- Resolve to rows, but never clear one already chosen by hand: an
  -- unparseable rename must not detach a course from its university or its
  -- specialisation.
  if new.university_label is not null then
    new.university_id := coalesce(app.resolve_university(new.university_label),
                                  new.university_id);
  end if;
  if new.track is not null then
    new.track_id := coalesce(app.resolve_track(new.track), new.track_id);
  end if;
  return new;
end;
$function$;

-- ---------------------------------------------------------------------------
-- 4. A student's university and specialisation
--
-- Almost every student's answer is already written down — in the titles of the
-- courses they bought. Reading it out beats asking for it, so the classifier
-- fills a BLANK field from the student's own subscriptions.
--
-- Two rules keep it honest:
--   * unanimity or nothing. A student on two universities' courses has no one
--     university, and guessing beats blank only until someone believes it.
--   * the admin wins, permanently. The moment either field is set or cleared
--     by hand the student is locked, so a cleared field stays cleared instead
--     of reappearing after the next payment.
-- ---------------------------------------------------------------------------
create or replace function app.classify_student(p_student uuid)
returns void language plpgsql security definer set search_path = '' as $function$
declare
  v_locked boolean;
  v_uni    uuid;
  v_track  uuid;
begin
  if p_student is null then return; end if;

  select classification_locked into v_locked
    from public.students where id = p_student;
  if v_locked is null or v_locked then return; end if;

  select case when count(distinct c.university_id) = 1
              then (array_agg(distinct c.university_id))[1] end
    into v_uni
    from public.subscriptions s
    join public.courses c on c.id = s.course_id
   where s.student_id = p_student and c.university_id is not null;

  select case when count(distinct c.track_id) = 1
              then (array_agg(distinct c.track_id))[1] end
    into v_track
    from public.subscriptions s
    join public.courses c on c.id = s.course_id
   where s.student_id = p_student and c.track_id is not null;

  if v_uni is null and v_track is null then return; end if;

  -- The flag tells the lock trigger below that this write is the classifier's,
  -- not a person's. Transaction-local, and cleared immediately after.
  perform set_config('app.autoclassify', 'on', true);
  update public.students
     set university_id = coalesce(university_id, v_uni),
         track_id      = coalesce(track_id, v_track)
   where id = p_student
     and (   (university_id is null and v_uni   is not null)
          or (track_id      is null and v_track is not null));
  perform set_config('app.autoclassify', '', true);
end;
$function$;

comment on function app.classify_student is
  'Fills a student''s blank university/specialisation from the courses they '
  'bought, but only when those courses agree, and never once an admin has '
  'touched either field.';

create or replace function app.lock_student_classification()
returns trigger language plpgsql set search_path = '' as $function$
begin
  if (new.university_id is distinct from old.university_id
      or new.track_id is distinct from old.track_id)
     and coalesce(current_setting('app.autoclassify', true), '') <> 'on'
  then
    new.classification_locked := true;
  end if;
  return new;
end;
$function$;

drop trigger if exists students_lock_classification on public.students;
create trigger students_lock_classification
  before update of university_id, track_id on public.students
  for each row execute function app.lock_student_classification();

create or replace function app.classify_student_from_subscription()
returns trigger language plpgsql security definer set search_path = '' as $function$
begin
  perform app.classify_student(new.student_id);
  if tg_op = 'UPDATE' and old.student_id is distinct from new.student_id then
    perform app.classify_student(old.student_id);
  end if;
  return null;
end;
$function$;

drop trigger if exists subscriptions_classify_student on public.subscriptions;
create trigger subscriptions_classify_student
  after insert or update of student_id, course_id on public.subscriptions
  for each row execute function app.classify_student_from_subscription();

-- A course learning its university or specialisation — from a rename, or from
-- an admin setting it — is new information about everyone on that course.
create or replace function app.classify_students_of_course()
returns trigger language plpgsql security definer set search_path = '' as $function$
declare r record;
begin
  if new.university_id is not distinct from old.university_id
     and new.track_id  is not distinct from old.track_id then
    return null;
  end if;
  for r in select distinct student_id from public.subscriptions
            where course_id = new.id and student_id is not null loop
    perform app.classify_student(r.student_id);
  end loop;
  return null;
end;
$function$;

drop trigger if exists courses_classify_students on public.courses;
create trigger courses_classify_students
  after update of university_id, track_id on public.courses
  for each row execute function app.classify_students_of_course();

-- Re-derive every course title against the new track resolution, then read the
-- result down onto the students.
update public.courses set name = name;

do $$
declare r record;
begin
  for r in select id from public.students loop
    perform app.classify_student(r.id);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- 5. The specialisation reaches the screens
--
-- CAUTION — `create or replace view` DISCARDS reloptions, and that silently
-- strips `security_invoker = on`, which is an RLS bypass. This has happened
-- twice in this project. A `create or replace view` is not finished until the
-- matching `alter view … set (security_invoker = on)` follows it here.
--
-- `search_students` returns `setof v_student_financials`, so it is dropped
-- before the view's shape changes and recreated after — with the new filter.
-- ---------------------------------------------------------------------------
drop function if exists public.search_students(
  text, uuid, uuid, text, boolean, text, date, date, boolean, boolean, int, int);

create or replace view public.v_student_financials as
select st.id as student_id,
       st.name, st.phone, st.phone_normalized, st.email, st.group_name,
       st.is_active, st.created_at as registered_at,
       st.university_id, u.name as university_name,
       coalesce(f.subscriptions_count, 0) as subscriptions_count,
       (coalesce(f.total_due, 0) + coalesce(pl.total_due, 0))::numeric(14,2) as total_due,
       (coalesce(f.total_paid, 0))::numeric(14,2)                            as total_paid,
       (coalesce(f.remaining, 0) + coalesce(pl.remaining, 0))::numeric(14,2) as remaining,
       greatest(f.last_payment_at, pl.last_payment_at) as last_payment_at,
       f.courses,
       case
         when coalesce(f.subscriptions_count, 0) = 0 then 'unknown'
         when coalesce(f.overdue_count, 0) > 0 then 'overdue'
         when coalesce(f.remaining, 0) + coalesce(pl.remaining, 0) <= 0
              and coalesce(f.total_due, 0) + coalesce(pl.total_due, 0) > 0 then 'paid'
         when coalesce(f.total_paid, 0) > 0 then 'partial'
         else 'unpaid'
       end as payment_status,
       coalesce(pl.plans_count, 0)   as installment_plans,
       coalesce(pl.remaining, 0)::numeric(14,2) as installment_remaining,
       -- Appended, because a replaced view may only grow at the end.
       st.track_id, tr.name as track_name,
       st.classification_locked
  from public.students st
  left join public.universities u on u.id = st.university_id
  left join public.tracks tr      on tr.id = st.track_id
  left join lateral (
    -- Plan-attached subscriptions are excluded here and counted once through
    -- the plan below.
    select count(*) as subscriptions_count,
           sum(sf.total_due) filter (where sf.plan_id is null)  as total_due,
           sum(sf.total_paid)                                   as total_paid,
           sum(sf.remaining) filter (where sf.plan_id is null)  as remaining,
           max(sf.last_payment_at)                              as last_payment_at,
           count(*) filter (where sf.payment_status = 'overdue') as overdue_count,
           string_agg(distinct c.name, ' · ')                   as courses
      from public.v_subscription_financials sf
      left join public.courses c on c.id = sf.course_id
     where sf.student_id = st.id
  ) f on true
  left join lateral (
    select count(*) as plans_count,
           sum(p.total_due) as total_due,
           sum(p.remaining) as remaining,
           max(p.last_payment_at) as last_payment_at
      from public.v_installment_plans p
     where p.student_id = st.id and p.closed_at is null
  ) pl on true;
alter view public.v_student_financials set (security_invoker = on);
grant select on public.v_student_financials to authenticated, service_role;

create or replace function public.search_students(
  p_search           text    default null,
  p_university_id    uuid    default null,
  p_track_id         uuid    default null,
  p_course_id        uuid    default null,
  p_payment_status   text    default null,
  p_active           boolean default null,
  p_group_name       text    default null,
  p_registered_from  date    default null,
  p_registered_to    date    default null,
  p_only_with_debt   boolean default false,
  p_only_fully_paid  boolean default false,
  p_limit            int     default 200,
  p_offset           int     default 0
)
returns setof public.v_student_financials
language sql
stable
security invoker
set search_path = ''
as $$
  select f.*
  from public.v_student_financials f
  where
    (p_search is null or btrim(p_search) = '' or
       f.name ilike '%' || btrim(p_search) || '%' or
       coalesce(f.phone, '') ilike '%' || btrim(p_search) || '%' or
       coalesce(f.phone_normalized, '') ilike '%' || public.normalize_phone(p_search) || '%')
    and (p_university_id is null or f.university_id = p_university_id)
    and (p_track_id is null or f.track_id = p_track_id)
    and (p_course_id is null or exists (
          select 1 from public.subscriptions s
           where s.student_id = f.student_id and s.course_id = p_course_id))
    and (p_payment_status is null or btrim(p_payment_status) = ''
         or f.payment_status = p_payment_status)
    and (p_active is null or f.is_active = p_active)
    and (p_group_name is null or btrim(p_group_name) = '' or f.group_name = p_group_name)
    and (p_registered_from is null
         or (f.registered_at at time zone 'Africa/Cairo')::date >= p_registered_from)
    and (p_registered_to is null
         or (f.registered_at at time zone 'Africa/Cairo')::date <= p_registered_to)
    and (not p_only_with_debt  or f.remaining > 0)
    and (not p_only_fully_paid or (f.remaining <= 0 and f.total_due > 0))
  order by f.name
  limit greatest(1, least(coalesce(p_limit, 200), 1000))
  offset greatest(0, coalesce(p_offset, 0))
$$;

revoke all on function public.search_students(
  text, uuid, uuid, uuid, text, boolean, text, date, date, boolean, boolean, int, int
) from public, anon;
grant execute on function public.search_students(
  text, uuid, uuid, uuid, text, boolean, text, date, date, boolean, boolean, int, int
) to authenticated;

create or replace view public.v_course_catalogue as
select c.id as course_id,
       c.name as course_name,
       c.is_active,
       u.id as university_id,
       coalesce(u.name, 'غير محدد') as university_name,
       coalesce(sub.subscriptions_count, 0) as students_count,
       (coalesce(sub.total_due, 0) + coalesce(pl.total_due, 0))::numeric(14,2) as total_due,
       (coalesce(sub.total_paid, 0))::numeric(14,2)                            as total_paid,
       (coalesce(sub.remaining, 0) + coalesce(pl.remaining, 0))::numeric(14,2) as remaining,
       c.subject,
       c.level,
       c.section,
       c.class_year,
       c.track,
       c.university_label,
       coalesce(sub.students_count, 0) as enrolled_students,
       coalesce(pl.plans_count, 0)     as installment_plans,
       c.track_id, tr.name as track_name
  from public.courses c
  left join public.universities u on u.id = c.university_id
  left join public.tracks tr      on tr.id = c.track_id
  left join lateral (
    select count(*) as subscriptions_count,
           count(distinct sf.student_id) as students_count,
           sum(sf.total_due)  filter (where sf.plan_id is null) as total_due,
           sum(sf.total_paid)                                   as total_paid,
           sum(sf.remaining)  filter (where sf.plan_id is null) as remaining
      from public.v_subscription_financials sf
     where sf.course_id = c.id
  ) sub on true
  left join lateral (
    select count(*) as plans_count,
           sum(p.total_due) as total_due,
           sum(p.remaining) as remaining
      from public.v_installment_plans p
     where p.course_id = c.id and p.closed_at is null
  ) pl on true;
alter view public.v_course_catalogue set (security_invoker = on);
grant select on public.v_course_catalogue to authenticated, service_role;

create or replace view public.v_subscriptions_list as
select s.id as subscription_id,
       s.order_id,
       s.source,
       s.created_at as enrolled_at,
       s.payment_date,
       s.due_date,
       s.installment_count,
       s.amount as order_amount,
       s.total_due as price_override,
       st.id as student_id, st.name as student_name, st.phone as student_phone,
       st.phone_normalized as student_phone_normalized,
       c.id as course_id, c.name as course_name,
       pk.id as package_id, pk.name as package_name, pk.price as package_price,
       coalesce(f.total_due, 0) as total_due,
       coalesce(f.total_paid, 0) as total_paid,
       coalesce(f.remaining, 0) as remaining,
       f.payment_status,
       coalesce(f.payments_count, 0) as payments_count,
       f.last_payment_at,
       case when s.total_due is not null then 'override'
            when pk.price is not null then 'package'
            when s.amount is not null then 'order'
            else 'none' end as price_source,
       s.plan_kind,
       s.plan_id,
       s.ukkera_transfer_id,
       s.merchant_order_key,
       pl.total_due  as plan_total_due,
       pl.total_paid as plan_total_paid,
       pl.remaining  as plan_remaining,
       pl.installments_paid,
       pl.installment_count as plan_installment_count,
       pl.next_installment_amount,
       pl.status as plan_status,
       c.university_id, c.university_label, c.level, c.section, c.class_year, c.track,
       pk.kind as package_kind, pk.installment_seq, pk.chapter_name,
       c.track_id, tr.name as track_name, u.name as university_name
  from public.subscriptions s
  left join public.students st on st.id = s.student_id
  left join public.courses c on c.id = s.course_id
  left join public.tracks tr on tr.id = c.track_id
  left join public.universities u on u.id = c.university_id
  left join public.packages pk on pk.id = s.package_id
  left join public.v_subscription_financials f on f.subscription_id = s.id
  left join public.v_installment_plans pl on pl.plan_id = s.plan_id;
alter view public.v_subscriptions_list set (security_invoker = on);
grant select on public.v_subscriptions_list to authenticated, service_role;

-- Revenue by specialisation, built exactly like revenue by university: net of
-- the gateway's cut, with the gross kept beside it under its own name.
create or replace view public.v_revenue_by_track as
select date_trunc('month', (e.occurred_at at time zone 'Africa/Cairo'))::date as month,
       tr.id as track_id,
       coalesce(tr.name, 'غير محدد') as track_name,
       sum(app.pnl_revenue(e.entry_type, e.amount))
         - sum(app.pnl_fee(e.entry_type, e.amount)) as revenue,
       count(*) filter (where e.entry_type = 'revenue') as payments,
       sum(app.pnl_revenue(e.entry_type, e.amount)) as student_payments,
       sum(app.pnl_fee(e.entry_type, e.amount))     as gateway_fees
  from public.ledger_entries e
  left join public.courses c on c.id = e.course_id
  left join public.tracks tr on tr.id = c.track_id
 where e.voided_at is null and not e.is_test
   and e.entry_type in ('revenue', 'refund', 'reversal', 'gateway_fee')
 group by 1, 2, 3;
alter view public.v_revenue_by_track set (security_invoker = on);
grant select on public.v_revenue_by_track to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 6. The specialisation joins the one rule for deleting records
--
-- 0035 put it in the database rather than the UI: a record that money points
-- at cannot be deleted. A new kind of record has to be taught there, not in a
-- screen — which is why all three functions are restated in full: `create or
-- replace function` has no way to add one branch.
--
-- A track holds no money of its own. What it holds is classification, and the
-- foreign keys are SET NULL, so deleting one un-labels courses and students
-- instead of destroying them. The dialog says so and lets it through.
-- ---------------------------------------------------------------------------
create or replace function app.record_links(p_kind text, p_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $function$
declare
  v_links      jsonb := '[]'::jsonb;
  v_label      text;
  v_exists     boolean := false;
  v_money_n    bigint  := 0;
  v_money_sum  numeric := 0;
  v_archivable boolean := false;
  v_archived   boolean := false;
  n            bigint;
begin
  if not app.is_admin() then raise exception 'forbidden'; end if;

  case p_kind
    when 'student' then
      select true, name, not is_active into v_exists, v_label, v_archived
        from public.students where id = p_id;
      v_archivable := true;

      select count(*), coalesce(sum(amount), 0) into v_money_n, v_money_sum
        from public.ledger_entries where student_id = p_id and voided_at is null;
      if v_money_n > 0 then
        v_links := v_links || jsonb_build_object(
          'what', 'ledger_entries', 'count', v_money_n, 'money', true);
      end if;

      select count(*) into n from public.subscriptions where student_id = p_id;
      if n > 0 then
        v_links := v_links || jsonb_build_object('what', 'subscriptions', 'count', n, 'money', false);
      end if;

      select count(*) into n from public.installment_plans where student_id = p_id;
      if n > 0 then
        v_links := v_links || jsonb_build_object('what', 'installment_plans', 'count', n, 'money', false);
      end if;

    when 'course' then
      select true, name, not is_active into v_exists, v_label, v_archived
        from public.courses where id = p_id;
      v_archivable := true;

      select count(*), coalesce(sum(amount), 0) into v_money_n, v_money_sum
        from public.ledger_entries where course_id = p_id and voided_at is null;
      if v_money_n > 0 then
        v_links := v_links || jsonb_build_object(
          'what', 'ledger_entries', 'count', v_money_n, 'money', true);
      end if;

      select count(*) into n from public.subscriptions where course_id = p_id;
      if n > 0 then
        v_links := v_links || jsonb_build_object('what', 'subscriptions', 'count', n, 'money', false);
      end if;

      select count(*) into n from public.packages where course_id = p_id;
      if n > 0 then
        v_links := v_links || jsonb_build_object('what', 'packages', 'count', n, 'money', false);
      end if;

      select count(*) into n from public.installment_plans where course_id = p_id;
      if n > 0 then
        v_links := v_links || jsonb_build_object('what', 'installment_plans', 'count', n, 'money', false);
      end if;

    when 'package' then
      select true, name into v_exists, v_label from public.packages where id = p_id;

      -- Money reaches a package only through the subscriptions that bought it.
      select count(*), coalesce(sum(e.amount), 0) into v_money_n, v_money_sum
        from public.ledger_entries e
        join public.subscriptions s on s.id = e.subscription_id
       where s.package_id = p_id and e.voided_at is null;
      if v_money_n > 0 then
        v_links := v_links || jsonb_build_object(
          'what', 'ledger_entries', 'count', v_money_n, 'money', true);
      end if;

      select count(*) into n from public.subscriptions where package_id = p_id;
      if n > 0 then
        v_links := v_links || jsonb_build_object('what', 'subscriptions', 'count', n, 'money', false);
      end if;

      select count(*) into n from public.installment_plans where package_id = p_id;
      if n > 0 then
        v_links := v_links || jsonb_build_object('what', 'installment_plans', 'count', n, 'money', false);
      end if;

    when 'subscription' then
      select true, order_id into v_exists, v_label from public.subscriptions where id = p_id;

      select count(*), coalesce(sum(amount), 0) into v_money_n, v_money_sum
        from public.ledger_entries where subscription_id = p_id and voided_at is null;
      if v_money_n > 0 then
        v_links := v_links || jsonb_build_object(
          'what', 'ledger_entries', 'count', v_money_n, 'money', true);
      end if;

      select count(*) into n from public.payment_subscription_overrides where subscription_id = p_id;
      if n > 0 then
        v_links := v_links || jsonb_build_object('what', 'overrides', 'count', n, 'money', false);
      end if;

    when 'university' then
      select true, name, not is_active into v_exists, v_label, v_archived
        from public.universities where id = p_id;
      v_archivable := true;

      select count(*) into n from public.courses where university_id = p_id;
      if n > 0 then
        v_links := v_links || jsonb_build_object('what', 'courses', 'count', n, 'money', false);
      end if;

      select count(*) into n from public.students where university_id = p_id;
      if n > 0 then
        v_links := v_links || jsonb_build_object('what', 'students', 'count', n, 'money', false);
      end if;

    when 'wallet' then
      select true, name, not is_active into v_exists, v_label, v_archived
        from public.wallets where id = p_id;
      v_archivable := true;

      -- Voided entries count here: the foreign key is RESTRICT, so they block
      -- the delete regardless, and a refusal that does not mention them would
      -- be a lie the database then contradicts.
      select count(*), coalesce(sum(amount) filter (where voided_at is null), 0)
        into v_money_n, v_money_sum
        from public.ledger_entries where wallet_id = p_id;
      if v_money_n > 0 then
        v_links := v_links || jsonb_build_object(
          'what', 'ledger_entries', 'count', v_money_n, 'money', true);
      end if;

    when 'installment_plan' then
      select true, coalesce(c.name, 'خطة أقساط'), pl.closed_at is not null
        into v_exists, v_label, v_archived
        from public.installment_plans pl
        left join public.courses c on c.id = pl.course_id
       where pl.id = p_id;
      -- Closing is this entity's archive: the plan stops counting toward
      -- outstanding without erasing what was collected against it.
      v_archivable := true;

      select count(*), coalesce(sum(e.amount), 0) into v_money_n, v_money_sum
        from public.ledger_entries e
        join public.subscriptions s on s.id = e.subscription_id
       where s.plan_id = p_id and e.voided_at is null;
      if v_money_n > 0 then
        v_links := v_links || jsonb_build_object(
          'what', 'ledger_entries', 'count', v_money_n, 'money', true);
      end if;

      select count(*) into n from public.subscriptions where plan_id = p_id;
      if n > 0 then
        v_links := v_links || jsonb_build_object('what', 'subscriptions', 'count', n, 'money', false);
      end if;

    when 'track' then
      select true, name, not is_active into v_exists, v_label, v_archived
        from public.tracks where id = p_id;
      v_archivable := true;

      select count(*) into n from public.courses where track_id = p_id;
      if n > 0 then
        v_links := v_links || jsonb_build_object('what', 'courses', 'count', n, 'money', false);
      end if;

      select count(*) into n from public.students where track_id = p_id;
      if n > 0 then
        v_links := v_links || jsonb_build_object('what', 'students', 'count', n, 'money', false);
      end if;

    else
      raise exception 'unknown record kind: %', p_kind;
  end case;

  return jsonb_build_object(
    'kind', p_kind,
    'exists', coalesce(v_exists, false),
    'label', v_label,
    'links', v_links,
    'money_count', v_money_n,
    'money_amount', v_money_sum,
    'blocked_by_money', v_money_n > 0,
    'can_delete', coalesce(v_exists, false) and v_money_n = 0,
    'can_archive', v_archivable,
    'archived', coalesce(v_archived, false)
  );
end;
$function$;

create or replace function public.delete_record(p_kind text, p_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $function$
declare
  v_info jsonb;
begin
  if not app.is_admin() then raise exception 'forbidden'; end if;

  v_info := app.record_links(p_kind, p_id);

  if not (v_info ->> 'exists')::boolean then
    return jsonb_build_object('ok', false, 'reason', 'not_found', 'info', v_info);
  end if;

  -- The one rule.
  if (v_info ->> 'blocked_by_money')::boolean then
    return jsonb_build_object('ok', false, 'reason', 'has_money', 'info', v_info);
  end if;

  -- No money, but still referenced. Allowed, because nothing irreversible is
  -- lost — but the caller is told what it detached so it can say so.
  case p_kind
    when 'student'          then delete from public.students          where id = p_id;
    when 'course'           then delete from public.courses           where id = p_id;
    when 'package'          then delete from public.packages          where id = p_id;
    when 'subscription'     then delete from public.subscriptions     where id = p_id;
    when 'university'       then delete from public.universities      where id = p_id;
    when 'track'            then delete from public.tracks            where id = p_id;
    when 'wallet'           then delete from public.wallets           where id = p_id;
    when 'installment_plan' then delete from public.installment_plans where id = p_id;
    else raise exception 'unknown record kind: %', p_kind;
  end case;

  return jsonb_build_object('ok', true, 'deleted', p_id, 'info', v_info);
end;
$function$;

create or replace function public.archive_record(
  p_kind text, p_id uuid, p_archived boolean default true
) returns jsonb language plpgsql security definer set search_path = '' as $function$
begin
  if not app.is_admin() then raise exception 'forbidden'; end if;

  case p_kind
    when 'student' then
      update public.students set is_active = not p_archived, updated_at = now() where id = p_id;
    when 'course' then
      update public.courses set is_active = not p_archived, updated_at = now() where id = p_id;
    when 'university' then
      update public.universities set is_active = not p_archived, updated_at = now() where id = p_id;
    when 'track' then
      update public.tracks set is_active = not p_archived, updated_at = now() where id = p_id;
    when 'wallet' then
      update public.wallets set is_active = not p_archived, updated_at = now() where id = p_id;
    when 'installment_plan' then
      update public.installment_plans
         set closed_at = case when p_archived then now() else null end, updated_at = now()
       where id = p_id;
    else
      return jsonb_build_object('ok', false, 'reason', 'not_archivable', 'kind', p_kind);
  end case;

  if not found then
    return jsonb_build_object('ok', false, 'reason', 'not_found');
  end if;
  return jsonb_build_object('ok', true, 'archived', p_archived);
end;
$function$;
