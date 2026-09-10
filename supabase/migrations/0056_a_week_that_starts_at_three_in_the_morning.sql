-- "This week" started at 3am.
--
-- Asked a plain question — how is task time counted — and the answer turned
-- out to be "not quite right at the boundary".
--
--   date_trunc('week', now() at time zone 'Africa/Cairo')
--
-- reads correctly and is not. `now() at time zone 'Africa/Cairo'` produces a
-- timestamp WITHOUT a time zone: the wall clock in Cairo, with no memory of
-- where it came from. `date_trunc` gives back Monday 00:00, still naive. Then
-- it is compared against `started_at`, which is a `timestamptz` — so Postgres
-- casts the naive value using the SESSION's zone, and this database runs in
-- UTC. Monday 00:00 Cairo became Monday 00:00 UTC, three hours late.
--
-- Anything worked between midnight and 3am on the first day of a week or a
-- month was counted in the previous one. Small, and exactly the kind of small
-- that makes somebody's hours not add up and nobody able to say why.
--
-- Two named functions rather than the incantation repeated at each site,
-- because the incantation is what went wrong: `... at time zone 'Africa/Cairo'`
-- applied a second time is what turns the wall clock back into an instant, and
-- it is easy to leave off precisely because the expression already mentions
-- Cairo once.

create or replace function app.cairo_week_start()
returns timestamptz language sql stable set search_path = '' as $$
  select date_trunc('week', now() at time zone 'Africa/Cairo') at time zone 'Africa/Cairo'
$$;

comment on function app.cairo_week_start is
  'Midnight on Monday in Cairo, as a real instant. The second `at time zone` '
  'is the whole point: without it the naive wall clock is read as UTC.';

create or replace function app.cairo_month_start()
returns timestamptz language sql stable set search_path = '' as $$
  select date_trunc('month', now() at time zone 'Africa/Cairo') at time zone 'Africa/Cairo'
$$;

comment on function app.cairo_month_start is
  'Midnight on the first of the month in Cairo, as a real instant.';

grant execute on function app.cairo_week_start()  to authenticated;
grant execute on function app.cairo_month_start() to authenticated;

-- The corrected view is applied from 0051 alongside this migration.

do $$
declare v_skew interval;
begin
  -- The bug, stated as a test: the naive form and the correct form must agree.
  select app.cairo_week_start()
       - (date_trunc('week', now() at time zone 'Africa/Cairo'))::timestamptz
    into v_skew;
  if v_skew = interval '0' then
    raise exception
      'this database is running in Cairo, so the bug this migration fixes is '
      'invisible here — the fix is still correct, but the assertion is not';
  end if;
end $$;
