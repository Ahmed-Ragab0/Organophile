-- 0037 — the door beside the delete rule.
--
-- 0035 put one rule in the database: a record that money points at cannot be
-- deleted. This closes what was standing open next to it.
--
-- Supabase's default privileges hand `authenticated` the FULL table privilege
-- set on everything in `public` — arwdDxtm — no matter what the migrations
-- grant. `ledger_entries` says `grant select … to authenticated` in 0015, has
-- RLS forced, and carries a SELECT-only policy. It still held TRUNCATE.
--
-- TRUNCATE is not subject to row-level security. There is no policy to consult
-- and no rows to filter: the whole table goes. So a signed-in user who is not
-- in `admin_users` — one RLS refuses every single row to — could still empty
-- the ledger with one statement, and the append-only guarantee with it.
--
-- Verified before writing this: `set role authenticated` with a JWT for a uuid
-- that is not an admin truncated a table successfully. Not theoretical.
--
-- The DML privileges stay exactly as they are. INSERT, UPDATE and DELETE are
-- all RLS-governed, and app.is_admin() decides every one of them. These four
-- are not governed by anything:
--
--   TRUNCATE   (D) — bypasses RLS entirely. The hole.
--   REFERENCES (x) — DDL: point a foreign key at this table.
--   TRIGGER    (t) — DDL: attach code to this table.
--   MAINTAIN   (m) — VACUUM / ANALYZE / REINDEX / REFRESH MATERIALIZED VIEW.
--
-- Nothing in this repository uses any of them from a client. `grep -ri truncate`
-- over web/src and supabase/functions returns nothing. A client that cannot do
-- a thing is a smaller surface than a client that may but does not.

revoke truncate, references, trigger, maintain
  on all tables in schema public from anon, authenticated;

-- The same for tables that do not exist yet, or the next migration to create
-- one hands the privilege straight back and this becomes a fix that held once.
--
-- Scoped to `postgres` because that is the role migrations and the SQL editor
-- run as, and default privileges are recorded per granting role. The parallel
-- entry owned by `supabase_admin` cannot be altered from here (postgres is not
-- a member of it) and covers only Supabase's own internal tables; the audit
-- view below is what would notice if one ever landed in `public`.
alter default privileges for role postgres in schema public
  revoke truncate, references, trigger, maintain on tables from anon, authenticated;

-- ---------------------------------------------------------------------------
-- Standing check, because this project has already watched a security setting
-- come back twice (`security_invoker` on views, 0028). A fix that is only
-- applied is a fix you have to remember; a fix that is also checked is one the
-- system tells you about.
--
-- Empty is the healthy answer. Every row is either a privilege the browser
-- client holds that RLS cannot govern, or a reachable table with no RLS at all.
-- ---------------------------------------------------------------------------
create or replace view public.v_client_access_audit as
select n.nspname || '.' || c.relname as object,
       g.role_name                   as grantee,
       g.privilege                   as finding
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
 cross join lateral (
   select r.role_name, p.privilege
     from unnest(array['anon', 'authenticated']) as r(role_name)
    cross join unnest(array['TRUNCATE', 'REFERENCES', 'TRIGGER', 'MAINTAIN'])
            as p(privilege)
    where has_table_privilege(r.role_name, c.oid, p.privilege)
 ) g
 where n.nspname = 'public' and c.relkind in ('r', 'p')
union all
select 'public.' || c.relname, '—', 'RLS OFF'
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
 where n.nspname = 'public' and c.relkind in ('r', 'p')
   and not c.relrowsecurity
   and (has_table_privilege('anon', c.oid, 'SELECT')
     or has_table_privilege('authenticated', c.oid, 'SELECT'));

-- `create or replace view` discards reloptions, so this line is part of the
-- statement above, not an afterthought. See the caution in 0028.
alter view public.v_client_access_audit set (security_invoker = on);

comment on view public.v_client_access_audit is
  'Anything the browser client can do that row-level security cannot govern. '
  'Empty means healthy; a row means a table got its default privileges back.';

grant select on public.v_client_access_audit to authenticated, service_role;
