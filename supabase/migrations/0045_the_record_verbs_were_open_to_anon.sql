-- 0006 ran `alter default privileges in schema public revoke all on functions
-- from anon`, and that has never done what it reads like. The default grant on
-- a new function is EXECUTE **to PUBLIC**, and `anon` holds it by being a
-- member of PUBLIC — so revoking from `anon` removes a grant it never had
-- directly and leaves the inherited one exactly where it was.
--
-- Every function created since has been callable with the anon key. Each one
-- opens with `if not app.is_admin() then raise exception 'forbidden'`, so
-- nothing leaked; but a rule enforced only inside the body is one refactor away
-- from not being enforced at all, and an unauthenticated caller should not
-- reach the body in the first place.
--
-- `add_expense` already carries this revoke, from the migration that rewrote
-- it. These are the three that did not.
do $$
declare f record;
begin
  for f in
    select p.oid::regprocedure as sig
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.proname in ('describe_record', 'delete_record', 'archive_record')
  loop
    execute format('revoke all on function %s from public, anon', f.sig);
    execute format('grant execute on function %s to authenticated, service_role', f.sig);
  end loop;
end $$;
