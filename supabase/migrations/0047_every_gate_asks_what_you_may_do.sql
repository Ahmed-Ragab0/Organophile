-- Every policy in this database asked one question — `app.is_admin()` — and
-- there was one answer, because there was one person. Now there are roles, and
-- the question has to become "may you do THIS".
--
-- Both halves are rewritten from a table rather than one statement at a time.
-- Twenty-two policies and ten function guards written out by hand is twenty-two
-- chances to give one table the wrong permission and never notice, because the
-- symptom is somebody quietly seeing something they should not.
--
-- The function half rewrites the STORED definition: it reads each function back
-- with `pg_get_functiondef`, swaps the guard, and re-creates it. That is the
-- only way to change a guard without re-declaring bodies this migration has no
-- business touching — and it asserts the old guard is present first, so if an
-- earlier migration has already changed one, this fails loudly instead of
-- silently leaving it open.

-- ---------------------------------------------------------------------------
-- Policies
-- ---------------------------------------------------------------------------
-- `*` in the read column means any active staff member. It is used for the
-- vocabulary lists — universities, tracks, expense categories, package types.
-- They carry no money and no personal data, they are what every dropdown in
-- the app is made of, and gating them by permission produces empty selects on
-- screens the person is allowed to use.
--
-- `-` in the write column means nothing may write from a client at all.
-- `ledger_entries` is the important one: rule 8 says every money movement goes
-- through a function, and the absence of a write policy is what enforces it.
do $do$
declare
  m          text[];
  tbl        text;
  read_perm  text;
  write_perm text;
  read_expr  text;
  write_expr text;
  pol        record;
  missing    text;
begin
  foreach m slice 1 in array array[
    ['students',                       'students.read',      'students.write'],
    ['courses',                        'courses.read',       'courses.write'],
    ['packages',                       'courses.read',       'courses.write'],
    ['universities',                   '*',                  'courses.write'],
    ['university_aliases',             '*',                  'courses.write'],
    ['tracks',                         '*',                  'courses.write'],
    ['track_aliases',                  '*',                  'courses.write'],
    ['expense_categories',             '*',                  'settings.write'],
    ['plan_kinds',                     '*',                  'settings.write'],
    ['subscriptions',                  'subscriptions.read', 'subscriptions.write'],
    ['subscription_installments',      'subscriptions.read', 'subscriptions.write'],
    ['installment_plans',              'subscriptions.read', 'subscriptions.write'],
    ['payments',                       'payments.read',      '-'],
    ['payouts',                        'payments.read',      '-'],
    ['payment_subscription_overrides', 'payments.read',      'payments.write'],
    ['ledger_entries',                 'money.read',         '-'],
    ['wallets',                        'money.read',         'money.write'],
    ['kashier_fee_schedule',           'money.read',         'settings.write'],
    ['kashier_account',                'money.read',         '-'],
    ['kashier_events_raw',             'system.read',        '-'],
    ['ukkera_events_raw',              'system.read',        '-'],
    ['webhook_rejections',             'system.read',        '-']
  ] loop
    tbl := m[1]; read_perm := m[2]; write_perm := m[3];

    if to_regclass('public.' || quote_ident(tbl)) is null then
      raise exception 'no such table: public.%', tbl;
    end if;

    -- Everything that was there before goes. A leftover permissive policy is a
    -- second, looser way in, and permissive policies OR together.
    for pol in select policyname from pg_policies
                where schemaname = 'public' and tablename = tbl loop
      execute format('drop policy %I on public.%I', pol.policyname, tbl);
    end loop;

    read_expr := case when read_perm = '*' then 'app.is_staff()'
                      else format('app.can(%L)', read_perm) end;
    execute format(
      'create policy %I on public.%I for select to authenticated using (%s)',
      tbl || '_read', tbl, read_expr);

    if write_perm <> '-' then
      write_expr := format('app.can(%L)', write_perm);
      execute format(
        'create policy %I on public.%I for all to authenticated using (%s) with check (%s)',
        tbl || '_write', tbl, write_expr, write_expr);
    end if;
  end loop;

  -- A table with RLS on and no policy at all denies everything, which is safe
  -- but is also how a table quietly disappears from the app. Name it now.
  select string_agg(c.relname, ', ') into missing
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relkind = 'r' and c.relrowsecurity
     and not exists (select 1 from pg_policies p
                      where p.schemaname = 'public' and p.tablename = c.relname);
  if missing is not null then
    raise exception 'tables with RLS and no policy: %', missing;
  end if;
end $do$;

-- ---------------------------------------------------------------------------
-- Function guards
-- ---------------------------------------------------------------------------
-- The three record verbs take a kind, so their guard is the kind's permission
-- rather than a fixed one. `describe_record` needs no entry: it is a one-line
-- wrapper around `app.record_links`, which is guarded here.
do $do$
declare
  m     text[];
  sch   text; fn text; guard text;
  n     int;
  def   text;
begin
  foreach m slice 1 in array array[
    ['public', 'add_expense',              'app.can(''money.write'')'],
    ['public', 'add_manual_revenue',       'app.can(''money.write'')'],
    ['public', 'transfer_between_wallets', 'app.can(''money.write'')'],
    ['public', 'void_ledger_entry',        'app.can(''money.write'')'],
    ['public', 'import_students',          'app.can(''students.write'')'],
    ['public', 'reconcile_transactions',   'app.can(''payments.write'')'],
    ['public', 'sweep_failed_events',      'app.can(''system.write'')'],
    ['public', 'delete_record',            'app.can(app.record_kind_permission(p_kind, ''write''))'],
    ['public', 'archive_record',           'app.can(app.record_kind_permission(p_kind, ''write''))'],
    ['app',    'record_links',             'app.can(app.record_kind_permission(p_kind, ''read''))']
  ] loop
    sch := m[1]; fn := m[2]; guard := m[3];

    select count(*) into n
      from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
     where ns.nspname = sch and p.proname = fn;
    if n <> 1 then
      raise exception 'expected exactly one %.%, found %', sch, fn, n;
    end if;

    select pg_get_functiondef(p.oid) into def
      from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
     where ns.nspname = sch and p.proname = fn;

    if position('app.is_admin()' in def) = 0 then
      raise exception '%.% no longer guards with app.is_admin() — check it by hand',
        sch, fn;
    end if;

    -- CREATE OR REPLACE keeps the function's existing privileges, so the
    -- revokes and grants made by earlier migrations survive this.
    execute replace(def, 'app.is_admin()', guard);
  end loop;
end $do$;

-- Nothing outside its own definition should still be asking the old question.
do $$
declare leftovers text;
begin
  select string_agg(ns.nspname || '.' || p.proname, ', ') into leftovers
    from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
   where ns.nspname in ('public', 'app')
     and p.prosrc like '%is_admin%'
     and not (ns.nspname = 'app' and p.proname = 'is_admin');
  if leftovers is not null then
    raise exception 'still guarded by app.is_admin(): %', leftovers;
  end if;
end $$;
