-- 0008_import.sql
-- Server-side import for the ukkera CSV exports.
--
-- Student matching lives here rather than in the browser so it is identical to
-- the rule the ukkera webhook projection already uses. Two different matchers
-- would eventually disagree and split one student into two records.
--
-- The financial export is deliberately READ-ONLY: it produces a comparison
-- report and never writes money. Kashier's signed webhook is the only thing
-- allowed to create or change a payment.

create or replace function public.import_students(p_rows jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  r            jsonb;
  v_name       text;
  v_phone      text;
  v_phone_n    text;
  v_ukkera_id  text;
  v_group      text;
  v_university text;
  v_email      text;
  v_id         uuid;
  v_count      int;
  n_inserted   int := 0;
  n_updated    int := 0;
  n_skipped    int := 0;
  v_errors     jsonb := '[]'::jsonb;
  i            int := 0;
begin
  if not app.is_admin() then
    raise exception 'forbidden';
  end if;

  if jsonb_typeof(p_rows) <> 'array' then
    raise exception 'p_rows must be a JSON array';
  end if;

  if jsonb_array_length(p_rows) > 10000 then
    raise exception 'too many rows in one import (max 10000)';
  end if;

  for r in select * from jsonb_array_elements(p_rows) loop
    i := i + 1;
    begin
      v_name       := nullif(btrim(coalesce(r ->> 'name', '')), '');
      v_phone      := nullif(btrim(coalesce(r ->> 'phone', '')), '');
      v_phone_n    := app.normalize_phone(v_phone);
      v_ukkera_id  := nullif(btrim(coalesce(r ->> 'ukkera_student_id', '')), '');
      v_group      := nullif(btrim(coalesce(r ->> 'group_name', '')), '');
      v_university := nullif(btrim(coalesce(r ->> 'university', '')), '');
      v_email      := nullif(btrim(coalesce(r ->> 'email', '')), '');

      -- A row with no name and no identifier cannot become a student.
      if v_name is null and v_ukkera_id is null and v_phone_n is null then
        n_skipped := n_skipped + 1;
        continue;
      end if;

      v_id := null;

      -- 1. ukkera's own id is authoritative when the export carries it.
      if v_ukkera_id is not null then
        select id into v_id from public.students where ukkera_student_id = v_ukkera_id;
      end if;

      -- 2. Otherwise phone, normalised the same way the webhook does.
      if v_id is null and v_phone_n is not null then
        select id into v_id from public.students
         where phone_normalized = v_phone_n
         order by created_at asc limit 1;
      end if;

      -- 3. Otherwise an exact name match, but only when unambiguous.
      if v_id is null and v_name is not null then
        select count(*) into v_count from public.students
         where upper(btrim(name)) = upper(btrim(v_name));
        if v_count = 1 then
          select id into v_id from public.students
           where upper(btrim(name)) = upper(btrim(v_name)) limit 1;
        end if;
      end if;

      if v_id is null then
        insert into public.students (name, phone, ukkera_student_id, group_name, university, email)
        values (coalesce(v_name, v_phone_n), v_phone, v_ukkera_id, v_group, v_university, v_email);
        n_inserted := n_inserted + 1;
      else
        -- Fill gaps and refresh roster fields, but never blank out a value we
        -- already hold because this particular export left the cell empty.
        update public.students set
          name              = coalesce(v_name, name),
          phone             = coalesce(v_phone, phone),
          ukkera_student_id = coalesce(v_ukkera_id, ukkera_student_id),
          group_name        = coalesce(v_group, group_name),
          university        = coalesce(v_university, university),
          email             = coalesce(v_email, email),
          updated_at        = now()
        where id = v_id;
        n_updated := n_updated + 1;
      end if;

    exception when others then
      -- One malformed row must not abort a 3000-row import.
      v_errors := v_errors || jsonb_build_object('row', i, 'error', sqlerrm);
      n_skipped := n_skipped + 1;
    end;
  end loop;

  return jsonb_build_object(
    'inserted', n_inserted,
    'updated',  n_updated,
    'skipped',  n_skipped,
    'errors',   v_errors
  );
end;
$$;

revoke all on function public.import_students(jsonb) from public, anon;
grant execute on function public.import_students(jsonb) to authenticated;

-- ---------------------------------------------------------------------------
-- Financial export reconciliation — reports only, never writes.
-- ---------------------------------------------------------------------------

create or replace function public.reconcile_transactions(p_rows jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  r          jsonb;
  v_order    text;
  v_amount   numeric;
  v_db       record;
  n_matched  int := 0;
  n_missing  int := 0;
  n_mismatch int := 0;
  v_issues   jsonb := '[]'::jsonb;
begin
  if not app.is_admin() then
    raise exception 'forbidden';
  end if;

  if jsonb_typeof(p_rows) <> 'array' then
    raise exception 'p_rows must be a JSON array';
  end if;

  for r in select * from jsonb_array_elements(p_rows) loop
    v_order  := app.normalize_order_id(r ->> 'order_id');
    v_amount := app.to_numeric(r ->> 'amount');
    if v_order is null then continue; end if;

    select sum(app.signed_amount(p.event, p.status, p.amount)) as net,
           count(*) filter (where p.status = 'SUCCESS') as ok_count
      into v_db
      from public.payments p
     where p.merchant_order_key = v_order and p.mode = 'live';

    if coalesce(v_db.ok_count, 0) = 0 then
      n_missing := n_missing + 1;
      v_issues := v_issues || jsonb_build_object(
        'order_id', v_order, 'issue', 'missing_in_kashier', 'file_amount', v_amount);
    elsif v_amount is not null and v_db.net is not null and v_db.net <> v_amount then
      n_mismatch := n_mismatch + 1;
      v_issues := v_issues || jsonb_build_object(
        'order_id', v_order, 'issue', 'amount_mismatch',
        'file_amount', v_amount, 'kashier_amount', v_db.net);
    else
      n_matched := n_matched + 1;
    end if;
  end loop;

  return jsonb_build_object(
    'matched', n_matched, 'missing', n_missing, 'mismatched', n_mismatch,
    'issues', v_issues
  );
end;
$$;

revoke all on function public.reconcile_transactions(jsonb) from public, anon;
grant execute on function public.reconcile_transactions(jsonb) to authenticated;
