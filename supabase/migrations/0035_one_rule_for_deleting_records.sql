-- Every table here already grants admins ALL, so a delete has always been one
-- request away — and the foreign keys make that quietly destructive:
--
--   delete a student  -> installment_plans CASCADE (their plans vanish)
--                     -> ledger_entries SET NULL (200 EGP becomes anonymous)
--   delete a course   -> packages CASCADE
--   delete a sub      -> subscription_installments + overrides CASCADE
--
-- None of that raises an error. The money stays on the books, correct in total,
-- attached to nobody — which is the worst shape a financial record can take,
-- because nothing ever tells you it happened.
--
-- So: one rule, enforced in the database rather than suggested by the UI.
--
--   A record that money points at cannot be deleted.
--
-- Not "should not". The delete is refused, and the refusal names what is
-- attached and offers the alternative — archive it, which keeps the history and
-- takes it out of the lists. A screen can only ever suggest; this decides.

-- ---------------------------------------------------------------------------
-- What is attached to a record, and whether any of it is money.
-- One function that knows the graph, so no screen has to.
-- ---------------------------------------------------------------------------
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

    else
      raise exception 'unknown record kind: %', p_kind;
  end case;

  return jsonb_build_object(
    'kind', p_kind,
    'exists', coalesce(v_exists, false),
    'label', v_label,
    'links', v_links,
    'money_count', v_money_n,
    'money_amount', v_money_sum,
    'blocked_by_money', v_money_n > 0,
    'can_delete', coalesce(v_exists, false) and v_money_n = 0,
    'can_archive', v_archivable,
    'archived', coalesce(v_archived, false)
  );
end;
$function$;

comment on function app.record_links is
  'Everything attached to one record, and whether any of it is money. The '
  'single place that knows the reference graph, so no screen has to guess.';

create or replace function public.describe_record(p_kind text, p_id uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select app.record_links(p_kind, p_id)
$$;

comment on function public.describe_record is
  'What would be affected by deleting this record. Call it BEFORE offering the '
  'delete, so the confirmation states facts instead of asking blind.';

-- ---------------------------------------------------------------------------
-- The two verbs that go with describe_record.
--
-- delete_record refuses rather than throws when money is attached: a refusal
-- carrying the reason and the counts is something a screen can render, whereas
-- an exception is something it can only apologise for.
-- ---------------------------------------------------------------------------
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

  -- No money, but still referenced. Allowed, because nothing irreversible is
  -- lost — but the caller is told what it detached so it can say so.
  case p_kind
    when 'student'          then delete from public.students          where id = p_id;
    when 'course'           then delete from public.courses           where id = p_id;
    when 'package'          then delete from public.packages          where id = p_id;
    when 'subscription'     then delete from public.subscriptions     where id = p_id;
    when 'university'       then delete from public.universities      where id = p_id;
    when 'wallet'           then delete from public.wallets           where id = p_id;
    when 'installment_plan' then delete from public.installment_plans where id = p_id;
    else raise exception 'unknown record kind: %', p_kind;
  end case;

  return jsonb_build_object('ok', true, 'deleted', p_id, 'info', v_info);
end;
$function$;

comment on function public.delete_record is
  'Deletes a record only when no money points at it. Returns {ok:false, '
  'reason:"has_money", info:{...}} instead of raising, so the caller can '
  'explain rather than apologise.';

-- ---------------------------------------------------------------------------
-- The alternative the refusal offers. Keeps the history, takes the record out
-- of the lists. For a plan, "archived" means closed: it stops counting toward
-- what is still to collect without erasing what was collected.
-- ---------------------------------------------------------------------------
create or replace function public.archive_record(
  p_kind text, p_id uuid, p_archived boolean default true
) returns jsonb language plpgsql security definer set search_path = '' as $function$
begin
  if not app.is_admin() then raise exception 'forbidden'; end if;

  case p_kind
    when 'student' then
      update public.students set is_active = not p_archived, updated_at = now() where id = p_id;
    when 'course' then
      update public.courses set is_active = not p_archived, updated_at = now() where id = p_id;
    when 'university' then
      update public.universities set is_active = not p_archived, updated_at = now() where id = p_id;
    when 'wallet' then
      update public.wallets set is_active = not p_archived, updated_at = now() where id = p_id;
    when 'installment_plan' then
      update public.installment_plans
         set closed_at = case when p_archived then now() else null end, updated_at = now()
       where id = p_id;
    else
      return jsonb_build_object('ok', false, 'reason', 'not_archivable', 'kind', p_kind);
  end case;

  if not found then
    return jsonb_build_object('ok', false, 'reason', 'not_found');
  end if;
  return jsonb_build_object('ok', true, 'archived', p_archived);
end;
$function$;

comment on function public.archive_record is
  'Hides a record from the working lists without destroying it. This is what a '
  'blocked delete offers instead.';
