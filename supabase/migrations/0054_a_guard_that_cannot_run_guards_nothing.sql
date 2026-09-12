-- A trigger that refuses to run is not a rail, it is an outage.
--
-- Reported the day the task board went out: adding a task as an ordinary
-- employee failed with `permission denied for schema app`. Adding one as the
-- owner worked. Nothing about the task differed — what differed was the ROLE
-- the trigger ran as.
--
-- The mechanism, because it is worth writing down once:
--
--   * `authenticated` has USAGE on `public` and on `auth`, and NOT on `app`.
--     That is deliberate: `app` is this system's private schema.
--   * An RLS policy that calls `app.can(...)` still works, because the policy
--     expression was parsed when the policy was CREATED, by the owner. At
--     execution time PostgreSQL checks EXECUTE on the function, which
--     `authenticated` has. Name resolution already happened.
--   * The same is true of a view body.
--   * A plpgsql function body is different. It resolves `app.can(...)` at RUN
--     time, as the current user — and that resolution needs USAGE on the
--     schema. So a trigger function living in `app`, calling a sibling in
--     `app`, and NOT marked SECURITY DEFINER, works for the owner and fails
--     for everybody else.
--
-- Four functions were in that state. Three of them had never been exercised by
-- a non-superuser, which is exactly why this was not caught: every probe and
-- every test in this repo runs as `postgres`, and `postgres` can see `app`.
--
-- One of the four was also a security hole rather than only an outage.
-- `guard_ledger_payroll_void` asks whether a payslip points at the ledger
-- entry being voided. Running as the caller, it read `payslips` through the
-- caller's RLS — so somebody holding `money.write` and NOT `payroll.read` saw
-- no payslip, the guard passed, and they could void a salary entry from the
-- ledger screen while the payslip went on saying "paid". As SECURITY DEFINER
-- it sees the payslip and refuses, which is what 0049 said it did.

alter function app.guard_task()                security definer;
alter function app.guard_task_session()        security definer;
alter function app.guard_payslip()             security definer;
alter function app.guard_ledger_payroll_void() security definer;

-- ---------------------------------------------------------------------------
-- The rail for the rails
-- ---------------------------------------------------------------------------
/**
 * Every trigger function that reaches into `app` must be SECURITY DEFINER.
 *
 * A structural assertion rather than a behavioural test, on purpose. Testing
 * this by behaviour needs a session that is genuinely `authenticated` before
 * anything has been parsed as the owner — plpgsql caches plans per session, so
 * a `set local role` inside a DO block does NOT reproduce it, which is how the
 * existing suite ran green over four broken functions. This check does not
 * care what role it runs as.
 *
 * The match is on `app.<name>(` — a CALL — not on the string "app.", because
 * `app.autoclassify` is a GUC name that appears inside
 * `lock_student_classification` and needs no such thing.
 */
create or replace function app.assert_guards_can_run()
returns text language plpgsql stable set search_path = '' as $function$
declare v_bad text;
begin
  select string_agg(p.proname, ', ' order by p.proname) into v_bad
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'app'
     and p.prorettype = 'trigger'::regtype
     and not p.prosecdef
     and p.prosrc ~ 'app\.[a-z_]+\s*\(';

  if v_bad is not null then
    raise exception
      'trigger function(s) call into schema app without SECURITY DEFINER, so '
      'they work for the owner and fail for everybody else: %', v_bad;
  end if;

  return 'every trigger that reaches into app can run as anybody';
end;
$function$;

comment on function app.assert_guards_can_run is
  'Fails if a trigger function would raise `permission denied for schema app` '
  'for a signed-in user. Called by the SQL test suites.';

do $$
begin
  perform app.assert_guards_can_run();
end $$;
