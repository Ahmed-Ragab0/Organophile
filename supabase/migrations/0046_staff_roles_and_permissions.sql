-- Until now this system had exactly one kind of person: an `admin_users` row,
-- which meant everything. That was the right call for one owner and stops being
-- the right call the moment a second person needs to do one job — an accountant
-- who should never edit a student, a salesperson who should never see the
-- ledger.
--
-- So: a person is a `staff` row, a staff row has a `role`, and a role holds a
-- set of `permissions`. Three tables, one function, and every policy in the
-- database asks that function instead of asking whether you are the owner.
--
-- The parts that are deliberately NOT configurable:
--
--   * The permission CATALOGUE. `permissions` is what the code checks; a row
--     you can invent is a row nothing reads. It is seeded and left alone.
--   * The superuser role. One role is marked `is_superuser` and holds every
--     permission implicitly, including the ones added by future migrations. A
--     system where every door can be locked is a system that locks you out.
--   * Removing the last active superuser, and editing your own membership.
--     Both are refused by triggers, because both are one click from nobody
--     being able to get back in.
--
-- This does change the security posture, and it is worth stating plainly: the
-- app can now grant access to the app. A stolen session belonging to someone
-- with `staff.write` can create an accomplice, which was impossible when the
-- allowlist could only be edited in the SQL console. That is the price of the
-- feature. What limits it: only `staff.write` can do it, account creation goes
-- through an Edge Function that re-checks the caller, and every row records who
-- created it and when.

-- ---------------------------------------------------------------------------
-- What there is to be allowed to do
-- ---------------------------------------------------------------------------
create table if not exists public.permissions (
  code       text primary key,
  -- The domain is the group in the UI and the prefix in the code. The action
  -- is always read or write: a third level of granularity here would be
  -- guessing at distinctions nobody has asked for.
  domain     text not null,
  action     text not null check (action in ('read', 'write')),
  name       text not null,
  name_en    text,
  sort_order int not null default 100
);

comment on table public.permissions is
  'The catalogue the code checks. Seeded by migration and never edited from '
  'the app: a permission nobody reads is worse than no permission at all.';

insert into public.permissions (code, domain, action, name, name_en, sort_order) values
  ('overview.read',      'overview',      'read',  'النظرة العامة',           'Overview',              10),
  ('students.read',      'students',      'read',  'يشوف الطلاب',             'View students',         20),
  ('students.write',     'students',      'write', 'يعدّل الطلاب',            'Edit students',         21),
  ('courses.read',       'courses',       'read',  'يشوف الكورسات',           'View courses',          30),
  ('courses.write',      'courses',       'write', 'يعدّل الكورسات',          'Edit courses',          31),
  ('subscriptions.read', 'subscriptions', 'read',  'يشوف الاشتراكات',         'View subscriptions',    40),
  ('subscriptions.write','subscriptions', 'write', 'يعدّل الاشتراكات والأسعار','Edit subscriptions',   41),
  ('money.read',         'money',         'read',  'يشوف الفلوس والدفتر',     'View money & ledger',   50),
  ('money.write',        'money',         'write', 'يسجّل مصروفات وتحويلات',  'Record money',          51),
  ('payments.read',      'payments',      'read',  'يشوف المدفوعات والتحويلات','View payments',        60),
  ('payments.write',     'payments',      'write', 'يربط ويطابق المدفوعات',   'Match payments',        61),
  ('reports.read',       'reports',       'read',  'يشوف التقارير',           'View reports',          70),
  ('settings.read',      'settings',      'read',  'يشوف الإعدادات',          'View settings',         80),
  ('settings.write',     'settings',      'write', 'يعدّل القوايم والإعدادات','Edit settings',         81),
  ('staff.read',         'staff',         'read',  'يشوف الموظفين',           'View staff',            90),
  ('staff.write',        'staff',         'write', 'يضيف ويعدّل الموظفين',    'Manage staff',          91),
  ('system.read',        'system',        'read',  'يشوف حالة النظام',        'View system health',   100),
  ('system.write',       'system',        'write', 'يشغّل المزامنة والاستيراد','Run sync & import',   101)
on conflict (code) do update
  set domain = excluded.domain, action = excluded.action,
      name = excluded.name, name_en = excluded.name_en,
      sort_order = excluded.sort_order;

-- ---------------------------------------------------------------------------
-- Roles
-- ---------------------------------------------------------------------------
create table if not exists public.roles (
  id           uuid primary key default gen_random_uuid(),
  code         text unique,
  name         text not null check (btrim(name) <> ''),
  name_en      text,
  description  text,
  /**
   * Holds every permission, present and future, and cannot be emptied. Exactly
   * one role has this, and it exists so that adding a permission in a later
   * migration never silently locks the owner out of the thing it guards.
   */
  is_superuser boolean not null default false,
  is_system    boolean not null default false,
  is_active    boolean not null default true,
  sort_order   int not null default 100,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

-- Exactly one, forever. Two roles that both hold everything is two places to
-- look when someone can do something they should not.
create unique index if not exists roles_one_superuser
  on public.roles (is_superuser) where is_superuser;

create or replace function app.role_code()
returns trigger language plpgsql set search_path = '' as $function$
begin
  if nullif(btrim(coalesce(new.code, '')), '') is null then
    new.code := 'r_' || substr(md5(upper(btrim(new.name))), 1, 10);
  end if;
  return new;
end;
$function$;

drop trigger if exists roles_fill_code on public.roles;
create trigger roles_fill_code
  before insert on public.roles
  for each row execute function app.role_code();

drop trigger if exists roles_touch_updated_at on public.roles;
create trigger roles_touch_updated_at
  before update on public.roles
  for each row execute function app.touch_updated_at();

insert into public.roles (code, name, name_en, description, is_superuser, is_system, sort_order)
values
  ('admin', 'مدير', 'Admin',
   'بيشوف ويعمل كل حاجة في السيستم. مينفعش يتشال آخر واحد منهم.', true, true, 10),
  ('accountant', 'محاسب', 'Accountant',
   'الفلوس والدفتر والتقارير — بيشوف الطلاب والاشتراكات من غير ما يعدّلهم.',
   false, true, 20),
  ('sales', 'سيلز', 'Sales',
   'الطلاب والاشتراكات والأسعار. مبيشوفش الدفتر ولا المصروفات.', false, true, 30),
  ('viewer', 'مشاهدة', 'Viewer', 'بيشوف من غير ما يعدّل حاجة.', false, true, 40)
on conflict (code) do update
  set name = excluded.name, name_en = excluded.name_en,
      description = excluded.description, is_system = true;

-- ---------------------------------------------------------------------------
-- What each role may do
-- ---------------------------------------------------------------------------
create table if not exists public.role_permissions (
  role_id         uuid not null references public.roles(id) on delete cascade,
  permission_code text not null references public.permissions(code) on delete cascade,
  primary key (role_id, permission_code)
);

-- The superuser role gets no rows: its permissions are implicit, and a stored
-- set would go stale the first time a migration adds a permission.
insert into public.role_permissions (role_id, permission_code)
select r.id, p.code
  from public.roles r
  cross join public.permissions p
 where r.code = 'accountant'
   and p.code in ('overview.read', 'money.read', 'money.write', 'payments.read',
                  'reports.read', 'subscriptions.read', 'students.read',
                  'settings.read', 'courses.read')
on conflict do nothing;

insert into public.role_permissions (role_id, permission_code)
select r.id, p.code
  from public.roles r
  cross join public.permissions p
 where r.code = 'sales'
   and p.code in ('overview.read', 'students.read', 'students.write',
                  'subscriptions.read', 'subscriptions.write',
                  'courses.read', 'reports.read')
on conflict do nothing;

insert into public.role_permissions (role_id, permission_code)
select r.id, p.code
  from public.roles r
  cross join public.permissions p
 where r.code = 'viewer' and p.action = 'read' and p.domain <> 'staff'
on conflict do nothing;

-- ---------------------------------------------------------------------------
-- The people
-- ---------------------------------------------------------------------------
create table if not exists public.staff (
  user_id      uuid primary key references auth.users(id) on delete cascade,
  email        text not null,
  full_name    text,
  phone        text,
  role_id      uuid not null references public.roles(id) on delete restrict,
  is_active    boolean not null default true,
  note         text,
  created_by   uuid references auth.users(id) on delete set null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

comment on table public.staff is
  'Who may use this system, and as what. A row here is the whole of access '
  'control; there is no second list.';

create index if not exists staff_role_idx on public.staff (role_id);

drop trigger if exists staff_touch_updated_at on public.staff;
create trigger staff_touch_updated_at
  before update on public.staff
  for each row execute function app.touch_updated_at();

-- Everyone who was on the old allowlist becomes an admin, which is what that
-- row already meant.
insert into public.staff (user_id, email, role_id, created_at)
select a.user_id,
       coalesce(a.email, u.email, ''),
       (select id from public.roles where code = 'admin'),
       a.created_at
  from public.admin_users a
  left join auth.users u on u.id = a.user_id
on conflict (user_id) do nothing;

-- ---------------------------------------------------------------------------
-- The question every policy asks
-- ---------------------------------------------------------------------------
-- STABLE and SECURITY DEFINER for the same reason `app.is_admin` was: a policy
-- on `staff` that had to read `staff` through RLS would recurse forever.
create or replace function app.can(p_perm text)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1
      from public.staff s
      join public.roles r on r.id = s.role_id
     where s.user_id = auth.uid()
       and s.is_active
       and r.is_active
       and (
         r.is_superuser
         or exists (
           select 1 from public.role_permissions rp
            where rp.role_id = r.id and rp.permission_code = p_perm
         )
       )
  )
$$;

comment on function app.can is
  'Whether the signed-in person holds this permission. The superuser role '
  'answers true to everything, including permissions added after it existed.';

/**
 * Signed in AND on the staff list, whatever the role.
 *
 * This is the gate on the pure vocabulary lists — universities, tracks,
 * expense categories, package types. They carry no money and no personal data,
 * they are what every dropdown in the app is made of, and gating them by
 * permission produces empty selects on screens the person is allowed to use.
 */
create or replace function app.is_staff()
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.staff s
      join public.roles r on r.id = s.role_id
     where s.user_id = auth.uid() and s.is_active and r.is_active
  )
$$;

-- Kept, and now meaning what its name says: a member of the role that holds
-- everything. It is no longer the gate on ordinary work — `app.can` is.
create or replace function app.is_admin()
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.staff s
      join public.roles r on r.id = s.role_id
     where s.user_id = auth.uid() and s.is_active and r.is_active and r.is_superuser
  )
$$;

grant execute on function app.can(text) to authenticated;
grant execute on function app.is_staff() to authenticated;
grant execute on function app.is_admin() to authenticated;

-- ---------------------------------------------------------------------------
-- Which permission a record family belongs to
-- ---------------------------------------------------------------------------
-- `delete_record` takes a kind and has to decide whether the caller may delete
-- one. Putting the mapping here keeps the three record verbs identical to each
-- other and keeps the answer in one place when a family is added.
create or replace function app.record_kind_permission(p_kind text, p_action text)
returns text language sql immutable set search_path = '' as $$
  select case p_kind
    when 'student'           then 'students'
    when 'course'            then 'courses'
    when 'package'           then 'courses'
    when 'university'        then 'courses'
    when 'track'             then 'courses'
    when 'subscription'      then 'subscriptions'
    when 'installment_plan'  then 'subscriptions'
    when 'wallet'            then 'money'
    when 'expense_category'  then 'settings'
    when 'plan_kind'         then 'settings'
    -- An unknown kind maps to the permission nothing but a superuser holds by
    -- name, so a family added without touching this function fails closed.
    else 'staff'
  end || '.' || case when p_action = 'write' then 'write' else 'read' end
$$;

grant execute on function app.record_kind_permission(text, text) to authenticated;

-- ---------------------------------------------------------------------------
-- The rails
-- ---------------------------------------------------------------------------
-- Three ways to lock everyone out, all of them one click away, none of them
-- expressible as a constraint.
create or replace function app.guard_staff()
returns trigger language plpgsql set search_path = '' as $function$
declare
  v_superusers int;
  v_self       uuid := auth.uid();
begin
  if tg_op = 'DELETE' then
    if old.user_id = v_self then
      raise exception 'you cannot remove your own account'
        using errcode = 'restrict_violation';
    end if;
  elsif tg_op = 'UPDATE' then
    -- Changing your own role or switching yourself off is how an admin
    -- demotes themselves by accident and then cannot undo it.
    if old.user_id = v_self
       and (new.role_id is distinct from old.role_id
            or new.is_active is distinct from old.is_active) then
      raise exception 'you cannot change your own role or access'
        using errcode = 'restrict_violation';
    end if;
  end if;

  -- Whatever the operation, at least one active superuser must survive it.
  select count(*) into v_superusers
    from public.staff s
    join public.roles r on r.id = s.role_id
   where s.is_active and r.is_active and r.is_superuser
     and s.user_id <> old.user_id;

  if v_superusers = 0 then
    -- The row being changed is the last one. Allowed only if it stays one.
    if tg_op = 'DELETE' then
      raise exception 'this is the last administrator'
        using errcode = 'restrict_violation';
    end if;
    if not (new.is_active
            and exists (select 1 from public.roles r
                         where r.id = new.role_id and r.is_active and r.is_superuser)) then
      raise exception 'this is the last administrator'
        using errcode = 'restrict_violation';
    end if;
  end if;

  return case when tg_op = 'DELETE' then old else new end;
end;
$function$;

drop trigger if exists staff_guard on public.staff;
create trigger staff_guard
  before update or delete on public.staff
  for each row execute function app.guard_staff();

create or replace function app.guard_role()
returns trigger language plpgsql set search_path = '' as $function$
begin
  if tg_op = 'DELETE' then
    if old.is_system then
      raise exception 'built-in role % cannot be deleted', old.code
        using errcode = 'restrict_violation';
    end if;
    return old;
  end if;

  if old.is_superuser and (not new.is_superuser or not new.is_active) then
    raise exception 'the administrator role cannot be downgraded or switched off'
      using errcode = 'restrict_violation';
  end if;
  if new.is_superuser and not old.is_superuser then
    raise exception 'is_superuser is set by migration, not by an edit'
      using errcode = 'restrict_violation';
  end if;
  if old.is_system and new.code is distinct from old.code then
    raise exception 'a built-in role code cannot change'
      using errcode = 'restrict_violation';
  end if;
  return new;
end;
$function$;

drop trigger if exists roles_guard on public.roles;
create trigger roles_guard
  before update or delete on public.roles
  for each row execute function app.guard_role();

-- The superuser role's permissions are implicit, so a row here would be both
-- redundant and misleading — it would suggest the set is editable.
create or replace function app.guard_role_permission()
returns trigger language plpgsql set search_path = '' as $function$
begin
  if exists (select 1 from public.roles r
              where r.id = coalesce(new.role_id, old.role_id) and r.is_superuser) then
    raise exception 'the administrator role holds every permission implicitly'
      using errcode = 'restrict_violation';
  end if;
  return coalesce(new, old);
end;
$function$;

drop trigger if exists role_permissions_guard on public.role_permissions;
create trigger role_permissions_guard
  before insert or update or delete on public.role_permissions
  for each row execute function app.guard_role_permission();

-- ---------------------------------------------------------------------------
-- Reading it back
-- ---------------------------------------------------------------------------
create or replace view public.v_staff as
select s.user_id, s.email, s.full_name, s.phone, s.is_active, s.note,
       s.created_at, s.updated_at, s.created_by,
       r.id as role_id, r.code as role_code, r.name as role_name,
       r.name_en as role_name_en, r.is_superuser, r.is_active as role_is_active,
       cb.email as created_by_email,
       s.user_id = auth.uid() as is_me
  from public.staff s
  join public.roles r on r.id = s.role_id
  left join public.staff cb on cb.user_id = s.created_by;

alter view public.v_staff set (security_invoker = on);
grant select on public.v_staff to authenticated, service_role;

create or replace view public.v_roles as
select r.id, r.code, r.name, r.name_en, r.description,
       r.is_superuser, r.is_system, r.is_active, r.sort_order,
       r.created_at, r.updated_at,
       coalesce(m.n, 0) as members,
       case when r.is_superuser
            then (select array_agg(p.code order by p.sort_order) from public.permissions p)
            else coalesce(
              (select array_agg(rp.permission_code order by rp.permission_code)
                 from public.role_permissions rp where rp.role_id = r.id),
              '{}')
       end as permissions
  from public.roles r
  left join lateral (
    select count(*) n from public.staff s where s.role_id = r.id
  ) m on true;

alter view public.v_roles set (security_invoker = on);
grant select on public.v_roles to authenticated, service_role;

/**
 * Everything the app needs to decide what to render, in one call.
 *
 * SECURITY DEFINER on purpose: this is what the middleware asks before it knows
 * whether the caller may read `staff` at all, and a signed-in person who is not
 * on the list has to be able to get the answer "no" rather than an error.
 *
 * It answers only about the caller. There is no parameter, so it cannot be
 * pointed at anyone else.
 */
create or replace function public.my_access()
returns jsonb language sql stable security definer set search_path = '' as $$
  select coalesce(
    (select jsonb_build_object(
       'is_staff',   true,
       'user_id',    s.user_id,
       'email',      s.email,
       'full_name',  s.full_name,
       'role', jsonb_build_object(
         'id', r.id, 'code', r.code, 'name', r.name, 'name_en', r.name_en,
         'is_superuser', r.is_superuser),
       'permissions',
         case when r.is_superuser
              then (select coalesce(jsonb_agg(p.code order by p.sort_order), '[]'::jsonb)
                      from public.permissions p)
              else coalesce(
                (select jsonb_agg(rp.permission_code order by rp.permission_code)
                   from public.role_permissions rp where rp.role_id = r.id),
                '[]'::jsonb)
         end)
       from public.staff s
       join public.roles r on r.id = s.role_id
      where s.user_id = auth.uid() and s.is_active and r.is_active),
    jsonb_build_object('is_staff', false, 'permissions', '[]'::jsonb)
  )
$$;

revoke all on function public.my_access() from public, anon;
grant execute on function public.my_access() to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Security on the four new tables
-- ---------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['permissions', 'roles', 'role_permissions', 'staff'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('alter table public.%I force row level security', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
    execute format('grant select on public.%I to authenticated', t);
    execute format('grant all on public.%I to service_role', t);
  end loop;

  -- Everything except the catalogue is editable by someone; `permissions` is
  -- seeded by migration and stays SELECT-only at the grant level, so the fact
  -- that it is fixed does not depend on a policy being remembered.
  foreach t in array array['roles', 'role_permissions', 'staff'] loop
    execute format('grant insert, update, delete on public.%I to authenticated', t);
  end loop;
end $$;

-- The catalogue is read-only to everyone: it is seeded by migration, and a row
-- someone adds here is a permission no code path ever checks.
drop policy if exists permissions_read on public.permissions;
create policy permissions_read on public.permissions
  for select to authenticated using (app.can('staff.read'));

drop policy if exists roles_read  on public.roles;
drop policy if exists roles_write on public.roles;
create policy roles_read on public.roles
  for select to authenticated using (app.can('staff.read'));
create policy roles_write on public.roles
  for all to authenticated using (app.can('staff.write')) with check (app.can('staff.write'));

drop policy if exists role_permissions_read  on public.role_permissions;
drop policy if exists role_permissions_write on public.role_permissions;
create policy role_permissions_read on public.role_permissions
  for select to authenticated using (app.can('staff.read'));
create policy role_permissions_write on public.role_permissions
  for all to authenticated using (app.can('staff.write')) with check (app.can('staff.write'));

-- Your own row is always readable: the header shows your name and your role,
-- and needing `staff.read` to find out who you are would be absurd.
drop policy if exists staff_read  on public.staff;
drop policy if exists staff_write on public.staff;
create policy staff_read on public.staff
  for select to authenticated
  using (app.can('staff.read') or user_id = auth.uid());
create policy staff_write on public.staff
  for all to authenticated using (app.can('staff.write')) with check (app.can('staff.write'));

-- ---------------------------------------------------------------------------
-- The old allowlist is gone
-- ---------------------------------------------------------------------------
-- Two tables that both decide access is one table too many: the day they
-- disagree, nobody knows which one is right. Its rows moved to `staff` above.
drop table if exists public.admin_users;
