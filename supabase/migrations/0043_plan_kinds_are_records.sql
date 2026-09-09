-- `packages.kind` was a CHECK constraint listing four words. That is the right
-- shape for something the code branches on and the wrong shape for something a
-- business names — and this column is both. "الكورس كامل / شابتر / بالقسط" is
-- vocabulary; the next thing this business sells will not be one of the four,
-- and adding it should not be a deploy.
--
-- So the four become rows, and the column becomes a foreign key. Two things
-- are deliberately kept:
--
--   * The CODE stays. `installment` is not a label, it is the branch that
--     opens an instalment plan, and the parser writes it by name. A system row
--     can be renamed freely and never deleted, because its code is load-
--     bearing and its name is not.
--   * The parser still runs. What changes is that a kind chosen by hand now
--     survives a rename of the package, which it previously did not: the
--     name trigger overwrote it every time.

-- ---------------------------------------------------------------------------
-- The list
-- ---------------------------------------------------------------------------
create table if not exists public.plan_kinds (
  id         uuid primary key default gen_random_uuid(),
  -- Stable and machine-readable. Everything in the app filters and branches on
  -- this; `name` is only ever displayed.
  code       text unique,
  name       text not null check (btrim(name) <> ''),
  name_en    text,
  is_system  boolean not null default false,
  is_active  boolean not null default true,
  sort_order int not null default 100,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.plan_kinds is
  'What sort of thing a package is. The four seeded rows carry codes the '
  'parser and the instalment logic depend on; anything added after is a label '
  'the owner chose, with a generated code.';
comment on column public.plan_kinds.is_system is
  'Seeded, code-bearing, and undeletable. Renaming one is fine — the name is '
  'display only — but nothing may remove the branch the code names.';

-- A new kind arrives with a name and no code. Derived from the name rather
-- than random, so re-running a seed finds the row it already made; and hashed
-- rather than transliterated, because an Arabic name has no ASCII slug and a
-- half-empty one collides.
create or replace function app.plan_kind_code()
returns trigger language plpgsql set search_path = '' as $function$
begin
  if nullif(btrim(coalesce(new.code, '')), '') is null then
    new.code := 'k_' || substr(md5(upper(btrim(new.name))), 1, 10);
  end if;
  return new;
end;
$function$;

drop trigger if exists plan_kinds_fill_code on public.plan_kinds;
create trigger plan_kinds_fill_code
  before insert on public.plan_kinds
  for each row execute function app.plan_kind_code();

drop trigger if exists plan_kinds_touch_updated_at on public.plan_kinds;
create trigger plan_kinds_touch_updated_at
  before update on public.plan_kinds
  for each row execute function app.touch_updated_at();

insert into public.plan_kinds (code, name, name_en, is_system, sort_order)
values ('full',        'الكورس كامل', 'Full course', true, 10),
       ('chapter',     'شابتر',       'Chapter',     true, 20),
       ('installment', 'بالقسط',      'Instalments', true, 30),
       ('other',       'غير محدد',    'Unspecified', true, 900)
on conflict (code) do update
  set name      = excluded.name,
      name_en   = excluded.name_en,
      is_system = true;

-- ---------------------------------------------------------------------------
-- The columns point at it
-- ---------------------------------------------------------------------------
-- Anything already stored that is not one of the four would block the foreign
-- key. There should be nothing, but a constraint that assumes is a constraint
-- that fails at 2am, so unknown values become rows first.
insert into public.plan_kinds (code, name)
select distinct k, k from (
  select kind      as k from public.packages
  union
  select plan_kind as k from public.subscriptions
) x
where k is not null and k not in (select code from public.plan_kinds)
on conflict (code) do nothing;

alter table public.packages      drop constraint if exists packages_kind_check;
alter table public.subscriptions drop constraint if exists subscriptions_plan_kind_check;

alter table public.packages drop constraint if exists packages_kind_fkey;
alter table public.packages add constraint packages_kind_fkey
  foreign key (kind) references public.plan_kinds(code)
  on update cascade on delete restrict;

alter table public.subscriptions drop constraint if exists subscriptions_plan_kind_fkey;
alter table public.subscriptions add constraint subscriptions_plan_kind_fkey
  foreign key (plan_kind) references public.plan_kinds(code)
  on update cascade on delete restrict;

create index if not exists packages_kind_idx      on public.packages (kind);
create index if not exists subscriptions_kind_idx on public.subscriptions (plan_kind);

-- ---------------------------------------------------------------------------
-- A kind chosen by hand stays chosen
-- ---------------------------------------------------------------------------
-- The name trigger fires on `update of name` and rewrote `kind` from the title
-- every time. Correct while the four kinds were the only ones the parser could
-- produce; wrong the moment a person picks one the parser cannot spell. Same
-- shape as `students.classification_locked`: the machine fills the blank, a
-- person's answer is final.
alter table public.packages
  add column if not exists kind_locked boolean not null default false;

comment on column public.packages.kind_locked is
  'Set the moment someone edits `kind` directly. While it is true the name '
  'parser leaves the kind alone, so renaming the package never undoes the '
  'choice.';

create or replace function app.apply_package_name_parts()
returns trigger language plpgsql security definer set search_path = '' as $function$
declare
  a jsonb := app.parse_package_name(new.name);
begin
  new.installment_seq := (a ->> 'installment_seq')::int;
  new.chapter_name    := a ->> 'chapter';

  if not coalesce(new.kind_locked, false) then
    new.kind := coalesce(a ->> 'kind', 'other');
  end if;

  -- Three payments is this business's instalment plan; the column stays
  -- editable per package for the ones that differ.
  if new.kind = 'installment' and new.installment_count <= 1 then
    new.installment_count := 3;
  end if;
  return new;
end;
$function$;

-- A column trigger fires on the columns the UPDATE names, not on what another
-- trigger assigned — so this cannot fire from the one above, and the lock is
-- only ever set by someone actually writing to `kind`.
create or replace function app.lock_package_kind()
returns trigger language plpgsql set search_path = '' as $function$
begin
  new.kind_locked := true;
  return new;
end;
$function$;

drop trigger if exists packages_lock_kind on public.packages;
create trigger packages_lock_kind
  before update of kind on public.packages
  for each row execute function app.lock_package_kind();

-- ---------------------------------------------------------------------------
-- Security
-- ---------------------------------------------------------------------------
alter table public.plan_kinds enable row level security;
alter table public.plan_kinds force  row level security;

revoke all on public.plan_kinds from anon;
grant select, insert, update, delete on public.plan_kinds to authenticated;
grant all on public.plan_kinds to service_role;
revoke truncate, references, trigger, maintain
  on public.plan_kinds from anon, authenticated;

drop policy if exists plan_kinds_admin_all on public.plan_kinds;
create policy plan_kinds_admin_all on public.plan_kinds
  for all to authenticated using (app.is_admin()) with check (app.is_admin());

-- A system row's code is the branch, so it is protected in the database rather
-- than in a form. RLS cannot express "these columns but not those".
create or replace function app.guard_system_plan_kind()
returns trigger language plpgsql set search_path = '' as $function$
begin
  if tg_op = 'DELETE' then
    if old.is_system then
      raise exception 'system plan kind % cannot be deleted', old.code
        using errcode = 'restrict_violation';
    end if;
    return old;
  end if;

  if old.is_system and new.code is distinct from old.code then
    raise exception 'system plan kind code cannot change'
      using errcode = 'restrict_violation';
  end if;
  -- Nothing may promote itself into the protected set either.
  if new.is_system and not old.is_system then
    raise exception 'is_system is set by migration, not by an edit'
      using errcode = 'restrict_violation';
  end if;
  return new;
end;
$function$;

drop trigger if exists plan_kinds_guard_system on public.plan_kinds;
create trigger plan_kinds_guard_system
  before update or delete on public.plan_kinds
  for each row execute function app.guard_system_plan_kind();

-- ---------------------------------------------------------------------------
-- The list, with what points at each row
-- ---------------------------------------------------------------------------
create or replace view public.v_plan_kinds as
select k.id, k.code, k.name, k.name_en, k.is_system, k.is_active, k.sort_order,
       k.created_at, k.updated_at,
       coalesce(p.n, 0) as packages,
       coalesce(s.n, 0) as subscriptions
  from public.plan_kinds k
  left join lateral (select count(*) n from public.packages      x where x.kind      = k.code) p on true
  left join lateral (select count(*) n from public.subscriptions x where x.plan_kind = k.code) s on true;

alter view public.v_plan_kinds set (security_invoker = on);
grant select on public.v_plan_kinds to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Deleting one, under the one rule
-- ---------------------------------------------------------------------------
-- Two things stop a delete here and neither is money, which is why the family
-- contract carries `blocked_reason`. The foreign keys are ON DELETE RESTRICT,
-- so an in-use kind fails at the constraint no matter what a screen offers —
-- and a button that is enabled right up to the moment it throws is worse than
-- one that explains itself.
create or replace function app.record_links_plan_kind(p_id uuid)
returns table (
  is_found       boolean,
  label          text,
  archived       boolean,
  archivable     boolean,
  links          jsonb,
  money_count    bigint,
  money_amount   numeric,
  blocked_reason text
) language plpgsql stable security definer set search_path = '' as $function$
declare
  v_links  jsonb := '[]'::jsonb;
  v_code   text;
  v_system boolean := false;
  n        bigint;
begin
  is_found := false; archived := false; archivable := true;
  money_count := 0; money_amount := 0;

  select true, k.name, not k.is_active, k.code, k.is_system
    into is_found, label, archived, v_code, v_system
    from public.plan_kinds k where k.id = p_id;

  if not coalesce(is_found, false) then return next; return; end if;

  select count(*), coalesce(sum(e.amount) filter (where e.voided_at is null), 0)
    into money_count, money_amount
    from public.ledger_entries e
    join public.subscriptions s on s.id = e.subscription_id
   where s.plan_kind = v_code;
  if money_count > 0 then
    v_links := v_links || jsonb_build_object(
      'what', 'ledger_entries', 'count', money_count, 'money', true);
  end if;

  select count(*) into n from public.packages where kind = v_code;
  if n > 0 then
    v_links := v_links || jsonb_build_object('what', 'packages', 'count', n, 'money', false);
    blocked_reason := 'in_use';
  end if;

  select count(*) into n from public.subscriptions where plan_kind = v_code;
  if n > 0 then
    v_links := v_links || jsonb_build_object('what', 'subscriptions', 'count', n, 'money', false);
    blocked_reason := 'in_use';
  end if;

  -- Checked last so it wins: a seeded kind is undeletable whether or not
  -- anything currently uses it, and that is the more useful thing to say.
  if v_system then blocked_reason := 'system_record'; end if;

  links := v_links;
  return next;
end;
$function$;

create or replace function app.record_links_ext(p_kind text, p_id uuid)
returns table (
  is_found       boolean,
  label          text,
  archived       boolean,
  archivable     boolean,
  links          jsonb,
  money_count    bigint,
  money_amount   numeric,
  blocked_reason text
) language plpgsql stable security definer set search_path = '' as $function$
begin
  case p_kind
    when 'expense_category' then
      return query select * from app.record_links_expense_category(p_id);
    when 'plan_kind' then
      return query select * from app.record_links_plan_kind(p_id);
    else
      -- Unknown to this function. Returning no rows is the answer.
      return;
  end case;
end;
$function$;

create or replace function app.delete_record_ext(p_kind text, p_id uuid)
returns boolean language plpgsql security definer set search_path = '' as $function$
begin
  case p_kind
    when 'expense_category' then
      delete from public.expense_categories where id = p_id; return found;
    when 'plan_kind' then
      delete from public.plan_kinds where id = p_id; return found;
    else
      return null;    -- not a kind this function knows
  end case;
end;
$function$;

create or replace function app.archive_record_ext(
  p_kind text, p_id uuid, p_archived boolean
) returns boolean language plpgsql security definer set search_path = '' as $function$
begin
  case p_kind
    when 'expense_category' then
      update public.expense_categories
         set is_active = not p_archived, updated_at = now() where id = p_id;
      return found;
    when 'plan_kind' then
      -- Archiving a system kind is allowed and archiving is not deleting: it
      -- takes the row out of the pickers while every package already filed
      -- under it keeps its name.
      update public.plan_kinds
         set is_active = not p_archived, updated_at = now() where id = p_id;
      return found;
    else
      return null;
  end case;
end;
$function$;
