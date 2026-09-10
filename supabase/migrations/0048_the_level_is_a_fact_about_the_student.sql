-- Two things a course title already says that the student never inherited.
--
-- "ORGANIC 3 - Azhar Asyut - 2027 - Ph-D" carries a LEVEL and a TRACK. The
-- track has been read down onto the student since 0036; the level stopped at
-- the course, so there was no way to ask "who is in Organic 2" — the one
-- question a teaching business asks about a roster.
--
-- And "Ph-D" was not being read at all. The parser knew `Pharm D`, `PharmD`
-- and `PHARM-D`, and this account writes `Ph-D`, which matched none of them.
-- It fell through to the leftover bucket and was dropped on the floor: no
-- track on the course, therefore no track on any of its students. Silent, and
-- exactly the shape of bug that only shows up as an empty filter.

-- ---------------------------------------------------------------------------
-- 1. The parser learns the spelling this account actually uses
-- ---------------------------------------------------------------------------
create or replace function app.parse_course_name(p_name text)
returns jsonb
language plpgsql immutable parallel safe set search_path = '' as $function$
declare
  parts     text[];
  tok       text;
  t         text;
  m         text[];
  v_subject text;
  v_level   int;
  v_section text;
  v_year    int;
  v_track   text;
  rest      text[] := '{}';
begin
  if p_name is null or btrim(p_name) = '' then return '{}'::jsonb; end if;

  -- Spaces around the dash are required: Pharm-D, Beni-Suef and Kafr El-Sheikh
  -- are single tokens that a bare hyphen would tear in half.
  parts := regexp_split_to_array(btrim(p_name), '\s+[-–—]\s+');

  foreach tok in array parts loop
    tok := btrim(tok);
    continue when tok = '';
    t := app.text_key(tok);

    if v_level is null then
      m := regexp_match(t,
        '^(?:ORGANIC CHEMISTRY|ORGANIC|ORG|أورجانيك|اورجانيك|كيمياء عضوية|عضوية)\s*([0-9]+|I{1,3})$');
      if m is not null then
        v_subject := 'ORGANIC';
        v_level   := case m[1] when 'I' then 1 when 'II' then 2 when 'III' then 3
                               else m[1]::int end;
        continue;
      end if;
    end if;

    if v_year is null and t ~ '^(19|20)[0-9]{2}$' then
      v_year := t::int;
      continue;
    end if;

    if v_section is null then
      if    t in ('GIRLS', 'GIRL', 'بنات', 'طالبات') then v_section := 'Girls';  continue;
      elsif t in ('BOYS', 'BOY', 'بنين', 'أولاد', 'اولاد', 'طلاب') then v_section := 'Boys'; continue;
      elsif t in ('MIXED', 'MIX', 'مختلط') then v_section := 'Mixed'; continue;
      end if;
    end if;

    if v_track is null then
      if t like '%CLINICAL%' or t like '%اكلينيك%' or t like '%إكلينيك%' then
        v_track := 'Clinical'; continue;
      -- `^PH-?\s?D$` is anchored, unlike the PHARM patterns beside it: PHD as a
      -- substring of a longer word is not a track, but a token that is exactly
      -- Ph-D / PhD / PH D is the only thing it can be.
      elsif t ~ '^PH\s*-?\s*D$' or t ~ 'PHARM\s*-?\s*D' or t like '%PHARMD%'
            or t like '%فارم دي%' or t like '%فارماسي دي%' then
        v_track := 'Pharm D'; continue;
      elsif t like '%INDUSTRIAL%' or t like '%صناعية%' then
        v_track := 'Industrial'; continue;
      elsif t like '%BIOTECH%' or t like '%حيوية%' then
        v_track := 'Biotechnology'; continue;
      end if;
    end if;

    rest := rest || tok;
  end loop;

  return jsonb_strip_nulls(jsonb_build_object(
    'subject',    v_subject,
    'level',      v_level,
    'section',    v_section,
    'class_year', v_year,
    'track',      v_track,
    -- A leftover token is only a university if the name proved it was a course
    -- title at all. Without this guard a name with no structure — a package
    -- name that landed in the course field, say — produced a "university" that
    -- was the entire string, and one bad row would anchor a reporting group.
    -- Recognising nothing must produce nothing.
    'university',
      case when v_level is null and v_year is null
                and v_track is null and v_section is null
           then null
           -- The longest leftover, not the first: field order should not
           -- decide which token is the university.
           else (select r from unnest(rest) r order by length(r) desc limit 1)
      end,
    'recognised', (v_level is not null or v_year is not null
                   or v_track is not null or v_section is not null)
  ));
end;
$function$;

-- ---------------------------------------------------------------------------
-- 2. The student carries a level
-- ---------------------------------------------------------------------------
-- Same three rules the university and the specialisation already follow:
-- filled from the courses they bought, only when those courses agree, and
-- never again once a person has set it by hand.
alter table public.students
  add column if not exists level int check (level is null or level between 1 and 12);

comment on column public.students.level is
  'Which Organic the student is in, read down from their courses. NULL means '
  'either no course says, or their courses disagree — never "level zero".';

create index if not exists students_level_idx on public.students (level) where level is not null;

create or replace function app.classify_student(p_student uuid)
returns void language plpgsql security definer set search_path = '' as $function$
declare
  v_locked boolean;
  v_uni    uuid;
  v_track  uuid;
  v_level  int;
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

  -- Unanimity here too, and deliberately: someone taking Organic 1 and
  -- Organic 3 at once is not "in" either, and picking the higher one would be
  -- a guess that reads as a fact. The list still finds them — it matches the
  -- levels they are ENROLLED in as well as the one assigned to them.
  select case when count(distinct c.level) = 1
              then (array_agg(distinct c.level))[1] end
    into v_level
    from public.subscriptions s
    join public.courses c on c.id = s.course_id
   where s.student_id = p_student and c.level is not null;

  if v_uni is null and v_track is null and v_level is null then return; end if;

  -- The flag tells the lock trigger below that this write is the classifier's,
  -- not a person's. Transaction-local, and cleared immediately after.
  perform set_config('app.autoclassify', 'on', true);
  update public.students
     set university_id = coalesce(university_id, v_uni),
         track_id      = coalesce(track_id, v_track),
         level         = coalesce(level, v_level)
   where id = p_student
     and (   (university_id is null and v_uni   is not null)
          or (track_id      is null and v_track is not null)
          or (level         is null and v_level is not null));
  perform set_config('app.autoclassify', '', true);
end;
$function$;

comment on function app.classify_student is
  'Fills a student''s blank university, specialisation and level from the '
  'courses they bought, but only when those courses agree, and never once an '
  'admin has touched any of them.';

create or replace function app.lock_student_classification()
returns trigger language plpgsql set search_path = '' as $function$
begin
  if (new.university_id is distinct from old.university_id
      or new.track_id is distinct from old.track_id
      or new.level is distinct from old.level)
     and coalesce(current_setting('app.autoclassify', true), '') <> 'on'
  then
    new.classification_locked := true;
  end if;
  return new;
end;
$function$;

drop trigger if exists students_lock_classification on public.students;
create trigger students_lock_classification
  before update of university_id, track_id, level on public.students
  for each row execute function app.lock_student_classification();

-- A course learning its level is new information about everyone on it, the
-- same as learning its university.
create or replace function app.classify_students_of_course()
returns trigger language plpgsql security definer set search_path = '' as $function$
declare r record;
begin
  if new.university_id is not distinct from old.university_id
     and new.track_id  is not distinct from old.track_id
     and new.level     is not distinct from old.level then
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
  after update of university_id, track_id, level on public.courses
  for each row execute function app.classify_students_of_course();

-- Re-derive every course title against the corrected track vocabulary, then
-- read the result down onto the students.
update public.courses set name = name;

do $$
declare r record;
begin
  for r in select id from public.students loop
    perform app.classify_student(r.id);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- 3. It reaches the list, and the list can be filtered by it
-- ---------------------------------------------------------------------------
-- `search_students` returns `setof v_student_financials`, so it is dropped
-- before the view's shape changes and recreated after — with the new filter.
--
-- CAUTION — `create or replace view` DISCARDS reloptions, and that silently
-- strips `security_invoker = on`, which is an RLS bypass. The matching
-- `alter view … set (security_invoker = on)` follows below.
drop function if exists public.search_students(
  text, uuid, uuid, uuid, text, boolean, text, date, date, boolean, boolean, int, int);

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
       st.classification_locked,
       st.level,
       /*
        * What their courses say, as opposed to what is written on them.
        *
        * The three columns above hold ONE answer each and are null whenever
        * the courses disagree — correct, and useless for a filter: a student
        * on an Organic 1 course and an Organic 3 course would be invisible
        * under both. These carry every value their enrolments actually hold,
        * so the filter finds them under each.
        */
       coalesce(f.course_levels, '{}')         as course_levels,
       coalesce(f.course_track_ids, '{}')      as course_track_ids,
       coalesce(f.course_university_ids, '{}') as course_university_ids
  from public.students st
  left join public.universities u on u.id = st.university_id
  left join public.tracks tr      on tr.id = st.track_id
  left join lateral (
    -- Plan-attached subscriptions are excluded from the money here and counted
    -- once through the plan below; the course facts still come from all of them.
    select count(*) as subscriptions_count,
           sum(sf.total_due) filter (where sf.plan_id is null)  as total_due,
           sum(sf.total_paid)                                   as total_paid,
           sum(sf.remaining) filter (where sf.plan_id is null)  as remaining,
           max(sf.last_payment_at)                              as last_payment_at,
           count(*) filter (where sf.payment_status = 'overdue') as overdue_count,
           string_agg(distinct c.name, ' · ')                   as courses,
           array_agg(distinct c.level)         filter (where c.level is not null)
             as course_levels,
           array_agg(distinct c.track_id)      filter (where c.track_id is not null)
             as course_track_ids,
           array_agg(distinct c.university_id) filter (where c.university_id is not null)
             as course_university_ids
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

/*
 * The three classification filters now match EITHER the value written on the
 * student or one their courses carry.
 *
 * Before, filtering by "Clinical" missed every student whose own track was
 * blank because their courses disagreed — even though one of those courses was
 * Clinical. Broadening it is what makes the filter answer the question a
 * person is actually asking: who is in this, not who has this written on them.
 */
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
  p_level            int     default null,
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
    and (p_university_id is null
         or f.university_id = p_university_id
         or p_university_id = any(f.course_university_ids))
    and (p_track_id is null
         or f.track_id = p_track_id
         or p_track_id = any(f.course_track_ids))
    and (p_level is null
         or f.level = p_level
         or p_level = any(f.course_levels))
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
  text, uuid, uuid, uuid, text, boolean, text, date, date, boolean, boolean, int, int, int
) from public, anon;
grant execute on function public.search_students(
  text, uuid, uuid, uuid, text, boolean, text, date, date, boolean, boolean, int, int, int
) to authenticated;

-- ---------------------------------------------------------------------------
-- 4. Which levels exist at all
-- ---------------------------------------------------------------------------
-- The filter's options come from the data rather than from a hard-coded 1..4:
-- the day this business teaches an Organic 5, the dropdown should already
-- know.
create or replace view public.v_levels as
select l.level,
       (select count(*) from public.courses c where c.level = l.level)  as courses,
       (select count(*) from public.students s where s.level = l.level) as students
  from (
    select distinct level from public.courses  where level is not null
    union
    select distinct level from public.students where level is not null
  ) l
 order by l.level;

alter view public.v_levels set (security_invoker = on);
grant select on public.v_levels to authenticated, service_role;
