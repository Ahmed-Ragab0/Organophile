-- 0016 — search_students must not reach across into schema `app`.
--
-- The bug it fixes: the students page returned
--   "permission denied for schema app"
-- for every query, including one with no filters at all.
--
-- Why. `public.search_students` is the only SECURITY INVOKER routine in the
-- API surface, and deliberately so: it returns student rows, and INVOKER is
-- what keeps RLS on `v_student_financials` applying to the caller. A DEFINER
-- version would hand every authenticated user the whole student list.
--
-- But its body called `app.normalize_phone(...)`, and `authenticated` has no
-- USAGE on schema `app`. Schema USAGE is checked when the name is RESOLVED,
-- not when the expression is reached, so PostgreSQL refused the query while
-- planning it — which is why an empty search box failed the same way a real
-- search did, and why the `p_search is null` short-circuit never saved it.
--
-- The views get away with the same cross-schema calls because a view's query
-- is parsed once at CREATE time by the owner and stored with function OIDs
-- already resolved; nothing re-resolves `app.pnl_revenue` at select time.
-- A SQL function body is not stored that way.
--
-- The fix is a wrapper in `public`, not a `grant usage on schema app`:
-- schema `app` holds the ingest internals (sweep_failed_events, the projection
-- helpers), and opening it to every signed-in user to fix a phone search would
-- be trading a much larger surface for a much smaller one.

create or replace function public.normalize_phone(p text)
returns text
language sql
immutable
parallel safe
security definer
set search_path = ''
as $$
  select app.normalize_phone(p)
$$;

comment on function public.normalize_phone(text) is
  'Egyptian mobile number in one canonical shape (01XXXXXXXXX), Arabic-Indic '
  'digits included. A SECURITY DEFINER wrapper over app.normalize_phone so '
  'SECURITY INVOKER callers in public do not need USAGE on schema app. Pure '
  'string normalisation — it reads no table, so DEFINER grants no data access.';

revoke all on function public.normalize_phone(text) from public, anon;
grant execute on function public.normalize_phone(text) to authenticated, service_role;

-- Recreated verbatim apart from the schema-qualified call.
create or replace function public.search_students(
  p_search           text    default null,
  p_university_id    uuid    default null,
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
    -- Partial match across the two things a person actually remembers.
    (p_search is null or btrim(p_search) = '' or
       f.name ilike '%' || btrim(p_search) || '%' or
       coalesce(f.phone, '') ilike '%' || btrim(p_search) || '%' or
       coalesce(f.phone_normalized, '') ilike '%' || public.normalize_phone(p_search) || '%')
    and (p_university_id is null or f.university_id = p_university_id)
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
  text, uuid, uuid, text, boolean, text, date, date, boolean, boolean, int, int
) from public, anon;
grant execute on function public.search_students(
  text, uuid, uuid, text, boolean, text, date, date, boolean, boolean, int, int
) to authenticated;
