-- Giving somebody an account and putting them on the roster were two steps,
-- and the app made the OWNER do both while nagging the EMPLOYEE about it.
--
-- The symptom, reported the day the task board went out: a new account with a
-- tasks role opens the board and reads "your account is not linked to a
-- person — link it from Payroll → People". That page needs `payroll.write`,
-- which the account does not have. The message told somebody to do a thing
-- they are not allowed to do, about a gap somebody else left.
--
-- The gap is real and worth keeping: `employees` is who works here and `staff`
-- is who may sign in, and folding them together would force every paid person
-- to be given an email and a password (0049). But crossing it should be
-- automatic where it can be, and one click where it cannot.
--
-- Two halves here; the third — the one click — is on the Staff screen.

-- ---------------------------------------------------------------------------
-- Is there a person behind this login
-- ---------------------------------------------------------------------------
/**
 * The employee row for a login, or null.
 *
 * SECURITY DEFINER because `employees` is gated on `payroll.read` and the
 * question is being asked from the STAFF screen, by somebody who may hold
 * `staff.read` and nothing about salaries. What leaks is the existence of a
 * row and its id — not a name, not a wage. Anybody who can see the staff list
 * can already see that the person exists.
 */
create or replace function app.employee_id_for(p_user_id uuid)
returns uuid language sql stable security definer set search_path = '' as $$
  select e.id from public.employees e where e.user_id = p_user_id limit 1
$$;

grant execute on function app.employee_id_for(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- The link that makes itself
-- ---------------------------------------------------------------------------
/**
 * A new login adopts the employee row that already carries its email.
 *
 * The ordinary sequence is: somebody joins, gets added to the payroll list,
 * and is given an account afterwards. In that sequence the link is not a
 * decision anybody needs to make — the email is the same person — so the
 * database makes it rather than leaving a second form for somebody to forget.
 *
 * Only ever fills a BLANK `user_id`. An employee already linked to another
 * login is a fact somebody entered deliberately, and two accounts sharing one
 * email is not a situation to resolve by guessing.
 */
create or replace function app.link_staff_to_employee()
returns trigger language plpgsql security definer set search_path = '' as $function$
begin
  /*
   * Exactly one row, chosen explicitly.
   *
   * A bare `update ... where email matches` looks equivalent and is not: two
   * roster rows carrying the same address — the same person entered twice —
   * would both be handed this account, and `employees.user_id` is unique, so
   * the whole staff insert would fail with a constraint error nobody could
   * read. The oldest match wins, and only when the account has nobody yet.
   */
  update public.employees e
     set user_id = new.user_id, updated_at = now()
   where e.id = (
     select e2.id
       from public.employees e2
      where e2.user_id is null
        and nullif(btrim(coalesce(e2.email, '')), '') is not null
        and lower(btrim(e2.email)) = lower(btrim(new.email))
      order by e2.created_at
      limit 1)
     and not exists (
       select 1 from public.employees e3 where e3.user_id = new.user_id);
  return null;
end;
$function$;

drop trigger if exists staff_link_employee on public.staff;
create trigger staff_link_employee
  after insert on public.staff
  for each row execute function app.link_staff_to_employee();

-- Anybody already in this position when the migration runs. `distinct on`
-- for the same reason as above: one row per account, oldest first.
update public.employees e
   set user_id = pick.user_id, updated_at = now()
  from (
    select distinct on (s.user_id) s.user_id, e2.id as employee_id
      from public.staff s
      join public.employees e2
        on e2.user_id is null
       and nullif(btrim(coalesce(e2.email, '')), '') is not null
       and lower(btrim(e2.email)) = lower(btrim(s.email))
     where not exists (select 1 from public.employees e3 where e3.user_id = s.user_id)
     order by s.user_id, e2.created_at
  ) pick
 where e.id = pick.employee_id;

-- ---------------------------------------------------------------------------
-- The staff list says whether there is a person behind each login
-- ---------------------------------------------------------------------------
-- Re-declared to gain one column, which is the only way a view can. Every
-- existing column keeps its name, type and position; the new one goes on the
-- end; and `security_invoker` is set again because CREATE OR REPLACE discards
-- it — losing it here would show the whole staff list to everybody.
create or replace view public.v_staff as
select s.user_id, s.email, s.full_name, s.phone, s.is_active, s.note,
       s.created_at, s.updated_at, s.created_by,
       r.id as role_id, r.code as role_code, r.name as role_name,
       r.name_en as role_name_en, r.is_superuser, r.is_active as role_is_active,
       cb.email as created_by_email,
       s.user_id = auth.uid() as is_me,
       -- Null means this account cannot be given a task or run a timer, which
       -- is a thing the person GRANTING the role should see while they are
       -- granting it.
       app.employee_id_for(s.user_id) as employee_id
  from public.staff s
  join public.roles r on r.id = s.role_id
  left join public.staff cb on cb.user_id = s.created_by;

alter view public.v_staff set (security_invoker = on);
grant select on public.v_staff to authenticated, service_role;

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

  -- One login, one person. The backfill above must not have handed two
  -- employee rows to the same account.
  if exists (
    select 1 from public.employees where user_id is not null
     group by user_id having count(*) > 1
  ) then
    raise exception 'an account ended up on the roster twice';
  end if;
end $$;
