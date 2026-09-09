-- An expense category was a string typed into a row, chosen from a list that
-- lived in a TypeScript constant. Two consequences, both of them quiet:
--
--   * The list could only change by deploying the front end. "تصنيفات" is
--     business vocabulary, and business vocabulary belongs to the business.
--   * Renaming a category forked it. "تسويق" spelled twice is two rows in
--     `v_expenses_by_category`, and nothing says so — the same failure the
--     university and track aliases were built to prevent.
--
-- So a category becomes a record, and the ledger points at it by id. The text
-- column stays exactly where it is: it is the historical record of what was
-- typed at the time, and rows written before this migration have nothing else.
-- The views resolve through the id when there is one and fall back to the text
-- when there is not, so a rename reaches every row that has an id and never
-- rewrites history that does not.

-- ---------------------------------------------------------------------------
-- The list
-- ---------------------------------------------------------------------------
create table if not exists public.expense_categories (
  id         uuid primary key default gen_random_uuid(),
  name       text not null check (btrim(name) <> ''),
  name_key   text generated always as (upper(btrim(name))) stored,
  is_active  boolean not null default true,
  sort_order int not null default 100,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint expense_categories_name_uniq unique (name_key)
);

comment on table public.expense_categories is
  'The categories an expense can be filed under. Editable by the owner: this '
  'is the vocabulary of the business, not of the schema.';

drop trigger if exists expense_categories_touch_updated_at on public.expense_categories;
create trigger expense_categories_touch_updated_at
  before update on public.expense_categories
  for each row execute function app.touch_updated_at();

-- Seeded with the six the front end used to hard-code, plus anything already
-- written to the ledger, so nothing that exists today loses its name.
insert into public.expense_categories (name, sort_order)
values ('مرتبات', 10), ('تسويق', 20), ('إيجارات', 30),
       ('تقنية', 40), ('إنتاج محتوى', 50), ('أخرى', 900)
on conflict (name_key) do nothing;

insert into public.expense_categories (name)
select distinct btrim(e.category)
  from public.ledger_entries e
 where e.entry_type = 'expense'
   and nullif(btrim(coalesce(e.category, '')), '') is not null
on conflict (name_key) do nothing;

-- ---------------------------------------------------------------------------
-- The ledger points at it
-- ---------------------------------------------------------------------------
-- ON DELETE SET NULL, not RESTRICT: `delete_record` refuses a category that is
-- in use before it ever reaches the constraint, and if one is ever removed by
-- another route the entry must keep its own `category` text rather than block
-- the delete or vanish.
alter table public.ledger_entries
  add column if not exists category_id uuid
    references public.expense_categories(id) on delete set null;

create index if not exists ledger_entries_category_id_idx
  on public.ledger_entries (category_id) where category_id is not null;

update public.ledger_entries e
   set category_id = ec.id
  from public.expense_categories ec
 where e.category_id is null
   and upper(btrim(coalesce(e.category, ''))) = ec.name_key;

-- ---------------------------------------------------------------------------
-- Resolving a name to a row
-- ---------------------------------------------------------------------------
-- The import path and the webhook path both write categories as text. Rather
-- than make them fail on an unknown one, this creates it — the same decision
-- `app.resolve_track` makes, for the same reason: refusing to record money
-- because a label is new is the wrong trade.
create or replace function app.resolve_expense_category(p_name text)
returns uuid language plpgsql security definer set search_path = '' as $function$
declare
  v_name text := nullif(btrim(coalesce(p_name, '')), '');
  v_id   uuid;
begin
  if v_name is null then return null; end if;

  select id into v_id from public.expense_categories
   where name_key = upper(v_name) limit 1;
  if v_id is not null then return v_id; end if;

  insert into public.expense_categories (name) values (v_name)
  on conflict (name_key) do update set updated_at = now()
  returning id into v_id;

  return v_id;
end;
$function$;

comment on function app.resolve_expense_category is
  'Name in, row id out, creating the row when the name is new. A category '
  'nobody has used before is not a reason to reject an expense.';

-- ---------------------------------------------------------------------------
-- add_expense takes either
-- ---------------------------------------------------------------------------
-- Dropped rather than replaced: adding a parameter makes a second overload,
-- and PostgREST resolves an overloaded RPC by the keys it is sent — which is
-- exactly the kind of ambiguity that picks the wrong function on the day one
-- caller omits a field.
drop function if exists public.add_expense(text, text, numeric, uuid, timestamptz, text);

create or replace function public.add_expense(
  p_description text,
  p_category    text,
  p_amount      numeric,
  p_wallet_id   uuid,
  p_occurred_at timestamptz default now(),
  p_notes       text default null,
  p_category_id uuid default null
) returns uuid
language plpgsql security definer set search_path = '' as $function$
declare
  v_id       uuid;
  v_cat_id   uuid := p_category_id;
  v_cat_name text;
begin
  if not app.is_admin() then raise exception 'forbidden'; end if;
  if p_amount is null or p_amount <= 0 then
    raise exception 'amount must be greater than zero';
  end if;
  if nullif(btrim(coalesce(p_description,'')),'') is null then
    raise exception 'description is required';
  end if;

  perform app.require_wallet(p_wallet_id);

  -- An id wins over a name, because the id is the one that survives a rename.
  if v_cat_id is not null then
    select name into v_cat_name from public.expense_categories where id = v_cat_id;
    if v_cat_name is null then raise exception 'unknown expense category'; end if;
  else
    v_cat_name := nullif(btrim(coalesce(p_category, '')), '');
    if v_cat_name is null then raise exception 'category is required'; end if;
    v_cat_id := app.resolve_expense_category(v_cat_name);
    -- Read the stored spelling back: "تسويق " and "تسويق" resolve to one row,
    -- and the row's own name is the one that should be written.
    select name into v_cat_name from public.expense_categories where id = v_cat_id;
  end if;

  insert into public.ledger_entries (
    entry_type, wallet_id, amount, occurred_at, description, category, category_id,
    metadata, created_by
  ) values (
    'expense', p_wallet_id, p_amount, coalesce(p_occurred_at, now()),
    btrim(p_description), v_cat_name, v_cat_id,
    jsonb_build_object('notes', p_notes), auth.uid()
  )
  returning id into v_id;

  return v_id;
end;
$function$;

revoke all on function public.add_expense(text, text, numeric, uuid, timestamptz, text, uuid)
  from public, anon;
grant execute on function public.add_expense(text, text, numeric, uuid, timestamptz, text, uuid)
  to authenticated;

-- ---------------------------------------------------------------------------
-- Security
-- ---------------------------------------------------------------------------
alter table public.expense_categories enable row level security;
alter table public.expense_categories force  row level security;

revoke all on public.expense_categories from anon;
grant select, insert, update, delete on public.expense_categories to authenticated;
grant all on public.expense_categories to service_role;

-- The same revoke 0037 applies to every other table. A default privilege grant
-- is not retroactive, and this table is created after that migration ran.
revoke truncate, references, trigger, maintain
  on public.expense_categories from anon, authenticated;

drop policy if exists expense_categories_admin_all on public.expense_categories;
create policy expense_categories_admin_all on public.expense_categories
  for all to authenticated using (app.is_admin()) with check (app.is_admin());

-- ---------------------------------------------------------------------------
-- Reading it back
-- ---------------------------------------------------------------------------
-- The `category` column keeps its name and its type, so this is a replace, not
-- a rebuild — but it now reads through the id, which is what makes a rename
-- show up on rows written before the rename.
--
-- CREATE OR REPLACE VIEW discards reloptions, so security_invoker is set again
-- below. Every view in this project carries it; losing it silently is an RLS
-- bypass that no test would notice.
create or replace view public.v_ledger as
select e.id, e.entry_type, e.amount, e.occurred_at, e.description,
       coalesce(ec.name, e.category) as category,
       e.reference, e.metadata, e.is_test, e.transfer_group_id, e.voided_at,
       e.void_reason, e.created_at,
       app.wallet_delta(e.entry_type, e.amount) as wallet_delta,
       app.pnl_revenue(e.entry_type, e.amount)  as revenue_effect,
       app.pnl_expense(e.entry_type, e.amount)  as expense_effect,
       e.wallet_id, w.name as wallet_name, w.type as wallet_type,
       e.student_id, st.name as student_name, st.phone as student_phone,
       e.course_id, c.name as course_name,
       e.subscription_id, sub.order_id as subscription_order_id,
       e.payment_id, p.transaction_id as kashier_transaction_id,
       p.method as payment_method, p.status as payment_status,
       app.pnl_fee(e.entry_type, e.amount) as fee_effect,
       case when p.event in ('pay', 'capture')
            then abs(coalesce(p.amount, 0)) end as payment_gross,
       case when p.event in ('pay', 'capture')
            then coalesce(p.fees, 0) + coalesce(p.vat, 0)
               + app.bank_fee_at(p.mode, p.transaction_date) end as payment_fees,
       case when p.event in ('pay', 'capture')
            then abs(coalesce(p.amount, 0))
               - (coalesce(p.fees, 0) + coalesce(p.vat, 0)
                  + app.bank_fee_at(p.mode, p.transaction_date)) end as payment_net,
       p.fees                                        as payment_fee_gateway,
       p.vat                                         as payment_fee_vat,
       case when p.id is not null
            then app.bank_fee_at(p.mode, p.transaction_date) end as payment_fee_bank,
       p.settled_amount                              as payment_settled_amount,
       p.merchant_order_id                           as payment_merchant_order_id,
       p.ukkera_transfer_id                          as payment_link_id,
       p.card_brand                                  as payment_card_brand,
       p.masked_card                                 as payment_masked_card,
       p.channel                                     as payment_channel,
       p.transaction_date                            as payment_date,
       p.mode                                        as payment_mode,
       sub.ukkera_transfer_id                        as subscription_transfer_id,
       pk.name                                       as package_name,
       u.name                                        as university_name,
       -- Appended, so filtering by category is filtering by the row rather
       -- than by a spelling.
       e.category_id
  from public.ledger_entries e
  join public.wallets w on w.id = e.wallet_id
  left join public.expense_categories ec on ec.id = e.category_id
  left join public.students st on st.id = e.student_id
  left join public.courses c on c.id = e.course_id
  left join public.universities u on u.id = c.university_id
  left join public.subscriptions sub on sub.id = e.subscription_id
  left join public.packages pk on pk.id = sub.package_id
  left join public.payments p on p.id = e.payment_id;

alter view public.v_ledger set (security_invoker = on);

create or replace view public.v_expenses_by_category as
select
  date_trunc('month', (e.occurred_at at time zone 'Africa/Cairo')::date)::date as month,
  coalesce(ec.name, e.category, 'أخرى') as category,
  sum(e.amount) as total,
  count(*)      as entries,
  ec.id         as category_id
from public.ledger_entries e
left join public.expense_categories ec on ec.id = e.category_id
where e.voided_at is null and not e.is_test and e.entry_type = 'expense'
group by 1, 2, ec.id;

alter view public.v_expenses_by_category set (security_invoker = on);
grant select on public.v_expenses_by_category to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Deleting a category, under the one rule
-- ---------------------------------------------------------------------------
-- `app.record_links` grew a branch per record family and would have to be
-- re-declared in full for every new one. This opens an extension point instead:
-- the monolith keeps the families it already knows, and hands anything else to
-- a small function a later migration can replace on its own.
--
-- The contract is the values the outer function needs. Zero rows means "I do
-- not know this kind", which is what makes the exception still fire.
--
-- `blocked_reason` is the one addition to what the built-in families can say.
-- Money is not the only thing that makes a record undeletable — a row the code
-- itself branches on is another — and a refusal is only useful if it names
-- which one it is.
--
-- A family answers for itself, in a function of its own. The dispatcher below
-- is then one line per family, which is the only part a later migration has to
-- re-declare — so the fourth family cannot quietly stop matching the first
-- three by being written out again slightly differently.
create or replace function app.record_links_expense_category(p_id uuid)
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
  v_links jsonb := '[]'::jsonb;
begin
  -- Set before the lookup, so an id that matches nothing reports "does not
  -- exist" with the family's real capabilities rather than a row of nulls.
  is_found := false; archived := false; archivable := true;
  money_count := 0; money_amount := 0;

  select true, ec.name, not ec.is_active
    into is_found, label, archived
    from public.expense_categories ec where ec.id = p_id;

  -- Money reaches a category only through the entries filed under it. A voided
  -- entry still counts: it is a fact that was recorded, and a category is the
  -- only thing that explains it.
  select count(*), coalesce(sum(e.amount) filter (where e.voided_at is null), 0)
    into money_count, money_amount
    from public.ledger_entries e where e.category_id = p_id;
  if money_count > 0 then
    v_links := v_links || jsonb_build_object(
      'what', 'ledger_entries', 'count', money_count, 'money', true);
  end if;

  links := v_links;
  return next;
end;
$function$;

drop function if exists app.record_links_ext(text, uuid);
create function app.record_links_ext(p_kind text, p_id uuid)
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
    else
      -- Unknown to this function. Returning no rows is the answer.
      return;
  end case;
end;
$function$;

create or replace function app.delete_record_ext(p_kind text, p_id uuid)
returns boolean language plpgsql security definer set search_path = '' as $function$
begin
  if p_kind = 'expense_category' then
    delete from public.expense_categories where id = p_id;
    return found;
  end if;
  return null;      -- not a kind this function knows
end;
$function$;

create or replace function app.archive_record_ext(
  p_kind text, p_id uuid, p_archived boolean
) returns boolean language plpgsql security definer set search_path = '' as $function$
begin
  if p_kind = 'expense_category' then
    update public.expense_categories
       set is_active = not p_archived, updated_at = now()
     where id = p_id;
    return found;
  end if;
  return null;
end;
$function$;

create or replace function app.record_links(p_kind text, p_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $function$
declare
  v_links      jsonb := '[]'::jsonb;
  v_label      text;
  v_exists     boolean := false;
  v_money_n    bigint  := 0;
  v_money_sum  numeric := 0;
  v_archivable boolean := false;
  v_archived   boolean := false;
  v_blocked    text;
  n            bigint;
begin
  if not app.is_admin() then raise exception 'forbidden'; end if;

  case p_kind
    when 'student' then
      select true, name, not is_active into v_exists, v_label, v_archived
        from public.students where id = p_id;
      v_archivable := true;

      select count(*), coalesce(sum(amount), 0) into v_money_n, v_money_sum
        from public.ledger_entries where student_id = p_id and voided_at is null;
      if v_money_n > 0 then
        v_links := v_links || jsonb_build_object(
          'what', 'ledger_entries', 'count', v_money_n, 'money', true);
      end if;

      select count(*) into n from public.subscriptions where student_id = p_id;
      if n > 0 then
        v_links := v_links || jsonb_build_object('what', 'subscriptions', 'count', n, 'money', false);
      end if;

      select count(*) into n from public.installment_plans where student_id = p_id;
      if n > 0 then
        v_links := v_links || jsonb_build_object('what', 'installment_plans', 'count', n, 'money', false);
      end if;

    when 'course' then
      select true, name, not is_active into v_exists, v_label, v_archived
        from public.courses where id = p_id;
      v_archivable := true;

      select count(*), coalesce(sum(amount), 0) into v_money_n, v_money_sum
        from public.ledger_entries where course_id = p_id and voided_at is null;
      if v_money_n > 0 then
        v_links := v_links || jsonb_build_object(
          'what', 'ledger_entries', 'count', v_money_n, 'money', true);
      end if;

      select count(*) into n from public.subscriptions where course_id = p_id;
      if n > 0 then
        v_links := v_links || jsonb_build_object('what', 'subscriptions', 'count', n, 'money', false);
      end if;

      select count(*) into n from public.packages where course_id = p_id;
      if n > 0 then
        v_links := v_links || jsonb_build_object('what', 'packages', 'count', n, 'money', false);
      end if;

      select count(*) into n from public.installment_plans where course_id = p_id;
      if n > 0 then
        v_links := v_links || jsonb_build_object('what', 'installment_plans', 'count', n, 'money', false);
      end if;

    when 'package' then
      select true, name into v_exists, v_label from public.packages where id = p_id;

      -- Money reaches a package only through the subscriptions that bought it.
      select count(*), coalesce(sum(e.amount), 0) into v_money_n, v_money_sum
        from public.ledger_entries e
        join public.subscriptions s on s.id = e.subscription_id
       where s.package_id = p_id and e.voided_at is null;
      if v_money_n > 0 then
        v_links := v_links || jsonb_build_object(
          'what', 'ledger_entries', 'count', v_money_n, 'money', true);
      end if;

      select count(*) into n from public.subscriptions where package_id = p_id;
      if n > 0 then
        v_links := v_links || jsonb_build_object('what', 'subscriptions', 'count', n, 'money', false);
      end if;

      select count(*) into n from public.installment_plans where package_id = p_id;
      if n > 0 then
        v_links := v_links || jsonb_build_object('what', 'installment_plans', 'count', n, 'money', false);
      end if;

    when 'subscription' then
      select true, order_id into v_exists, v_label from public.subscriptions where id = p_id;

      select count(*), coalesce(sum(amount), 0) into v_money_n, v_money_sum
        from public.ledger_entries where subscription_id = p_id and voided_at is null;
      if v_money_n > 0 then
        v_links := v_links || jsonb_build_object(
          'what', 'ledger_entries', 'count', v_money_n, 'money', true);
      end if;

      select count(*) into n from public.payment_subscription_overrides where subscription_id = p_id;
      if n > 0 then
        v_links := v_links || jsonb_build_object('what', 'overrides', 'count', n, 'money', false);
      end if;

    when 'university' then
      select true, name, not is_active into v_exists, v_label, v_archived
        from public.universities where id = p_id;
      v_archivable := true;

      select count(*) into n from public.courses where university_id = p_id;
      if n > 0 then
        v_links := v_links || jsonb_build_object('what', 'courses', 'count', n, 'money', false);
      end if;

      select count(*) into n from public.students where university_id = p_id;
      if n > 0 then
        v_links := v_links || jsonb_build_object('what', 'students', 'count', n, 'money', false);
      end if;

    when 'wallet' then
      select true, name, not is_active into v_exists, v_label, v_archived
        from public.wallets where id = p_id;
      v_archivable := true;

      -- Voided entries count here: the foreign key is RESTRICT, so they block
      -- the delete regardless, and a refusal that does not mention them would
      -- be a lie the database then contradicts.
      select count(*), coalesce(sum(amount) filter (where voided_at is null), 0)
        into v_money_n, v_money_sum
        from public.ledger_entries where wallet_id = p_id;
      if v_money_n > 0 then
        v_links := v_links || jsonb_build_object(
          'what', 'ledger_entries', 'count', v_money_n, 'money', true);
      end if;

    when 'installment_plan' then
      select true, coalesce(c.name, 'خطة أقساط'), pl.closed_at is not null
        into v_exists, v_label, v_archived
        from public.installment_plans pl
        left join public.courses c on c.id = pl.course_id
       where pl.id = p_id;
      -- Closing is this entity's archive: the plan stops counting toward
      -- outstanding without erasing what was collected against it.
      v_archivable := true;

      select count(*), coalesce(sum(e.amount), 0) into v_money_n, v_money_sum
        from public.ledger_entries e
        join public.subscriptions s on s.id = e.subscription_id
       where s.plan_id = p_id and e.voided_at is null;
      if v_money_n > 0 then
        v_links := v_links || jsonb_build_object(
          'what', 'ledger_entries', 'count', v_money_n, 'money', true);
      end if;

      select count(*) into n from public.subscriptions where plan_id = p_id;
      if n > 0 then
        v_links := v_links || jsonb_build_object('what', 'subscriptions', 'count', n, 'money', false);
      end if;

    when 'track' then
      select true, name, not is_active into v_exists, v_label, v_archived
        from public.tracks where id = p_id;
      v_archivable := true;

      select count(*) into n from public.courses where track_id = p_id;
      if n > 0 then
        v_links := v_links || jsonb_build_object('what', 'courses', 'count', n, 'money', false);
      end if;

      select count(*) into n from public.students where track_id = p_id;
      if n > 0 then
        v_links := v_links || jsonb_build_object('what', 'students', 'count', n, 'money', false);
      end if;

    -- Anything registered by a later migration. Kept as a delegation rather
    -- than another branch here, so adding a record family never means
    -- re-declaring two hundred lines it does not touch — which is how the
    -- fourth branch quietly stops matching the first three.
    else
      select x.is_found, x.label, x.archived, x.archivable,
             x.links, x.money_count, x.money_amount, x.blocked_reason
        into v_exists, v_label, v_archived, v_archivable,
             v_links, v_money_n, v_money_sum, v_blocked
        from app.record_links_ext(p_kind, p_id) x;
      if not found then
        raise exception 'unknown record kind: %', p_kind;
      end if;
  end case;

  return jsonb_build_object(
    'kind', p_kind,
    'exists', coalesce(v_exists, false),
    'label', v_label,
    'links', v_links,
    'money_count', v_money_n,
    'money_amount', v_money_sum,
    'blocked_by_money', v_money_n > 0,
    'blocked_reason', v_blocked,
    'can_delete', coalesce(v_exists, false) and v_money_n = 0 and v_blocked is null,
    'can_archive', v_archivable,
    'archived', coalesce(v_archived, false)
  );
end;
$function$;

create or replace function public.delete_record(p_kind text, p_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $function$
declare
  v_info jsonb;
begin
  if not app.is_admin() then raise exception 'forbidden'; end if;

  v_info := app.record_links(p_kind, p_id);

  if not (v_info ->> 'exists')::boolean then
    return jsonb_build_object('ok', false, 'reason', 'not_found', 'info', v_info);
  end if;

  -- The one rule.
  if (v_info ->> 'blocked_by_money')::boolean then
    return jsonb_build_object('ok', false, 'reason', 'has_money', 'info', v_info);
  end if;

  -- A family may refuse for its own reason. It names it; this passes it on
  -- rather than translating it into a generic failure.
  if (v_info ->> 'blocked_reason') is not null then
    return jsonb_build_object(
      'ok', false, 'reason', v_info ->> 'blocked_reason', 'info', v_info);
  end if;

  -- No money, but still referenced. Allowed, because nothing irreversible is
  -- lost — but the caller is told what it detached so it can say so.
  case p_kind
    when 'student'          then delete from public.students          where id = p_id;
    when 'course'           then delete from public.courses           where id = p_id;
    when 'package'          then delete from public.packages          where id = p_id;
    when 'subscription'     then delete from public.subscriptions     where id = p_id;
    when 'university'       then delete from public.universities      where id = p_id;
    when 'track'            then delete from public.tracks            where id = p_id;
    when 'wallet'           then delete from public.wallets           where id = p_id;
    when 'installment_plan' then delete from public.installment_plans where id = p_id;
    else
      if app.delete_record_ext(p_kind, p_id) is null then
        raise exception 'unknown record kind: %', p_kind;
      end if;
  end case;

  return jsonb_build_object('ok', true, 'deleted', p_id, 'info', v_info);
end;
$function$;

create or replace function public.archive_record(
  p_kind text, p_id uuid, p_archived boolean default true
) returns jsonb language plpgsql security definer set search_path = '' as $function$
declare
  v_ext boolean;
begin
  if not app.is_admin() then raise exception 'forbidden'; end if;

  case p_kind
    when 'student' then
      update public.students set is_active = not p_archived, updated_at = now() where id = p_id;
    when 'course' then
      update public.courses set is_active = not p_archived, updated_at = now() where id = p_id;
    when 'university' then
      update public.universities set is_active = not p_archived, updated_at = now() where id = p_id;
    when 'track' then
      update public.tracks set is_active = not p_archived, updated_at = now() where id = p_id;
    when 'wallet' then
      update public.wallets set is_active = not p_archived, updated_at = now() where id = p_id;
    when 'installment_plan' then
      update public.installment_plans
         set closed_at = case when p_archived then now() else null end, updated_at = now()
       where id = p_id;
    else
      -- Returned rather than tested through FOUND: a function call in an IF
      -- condition does not set it, so the check below would read whatever the
      -- previous statement left behind.
      v_ext := app.archive_record_ext(p_kind, p_id, p_archived);
      if v_ext is null then
        return jsonb_build_object('ok', false, 'reason', 'not_archivable', 'kind', p_kind);
      elsif not v_ext then
        return jsonb_build_object('ok', false, 'reason', 'not_found');
      else
        return jsonb_build_object('ok', true, 'archived', p_archived);
      end if;
  end case;

  if not found then
    return jsonb_build_object('ok', false, 'reason', 'not_found');
  end if;
  return jsonb_build_object('ok', true, 'archived', p_archived);
end;
$function$;

-- ---------------------------------------------------------------------------
-- The list, with the one number that makes a delete decision possible
-- ---------------------------------------------------------------------------
-- Counted here rather than in the browser: the screen that manages categories
-- should not have to read every ledger entry to find out how many use one.
create or replace view public.v_expense_categories as
select ec.id, ec.name, ec.is_active, ec.sort_order, ec.created_at, ec.updated_at,
       coalesce(u.entries, 0)                        as entries,
       coalesce(u.total, 0)::numeric(14,2)           as total,
       u.last_used_at
  from public.expense_categories ec
  left join lateral (
    select count(*)                as entries,
           sum(e.amount)           as total,
           max(e.occurred_at)      as last_used_at
      from public.ledger_entries e
     where e.category_id = ec.id and e.voided_at is null and not e.is_test
  ) u on true;

alter view public.v_expense_categories set (security_invoker = on);
grant select on public.v_expense_categories to authenticated, service_role;
