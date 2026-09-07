-- 0011_reconcile_mode_parameter.sql
--
-- reconcile_transactions hardcoded `mode = 'live'`, which made it report every
-- row of a test-mode dataset as "missing_in_kashier" — a confidently wrong
-- answer rather than an empty one. Live remains the default because the ukkera
-- financial export is an export of real money, but the mode is now explicit so
-- the report can be exercised before go-live.

drop function if exists public.reconcile_transactions(jsonb);

create or replace function public.reconcile_transactions(
  p_rows jsonb,
  p_mode public.kashier_mode default 'live'
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  r          jsonb;
  v_order    text;
  v_amount   numeric;
  v_net      numeric;
  v_ok       int;
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

    select sum(app.signed_amount(p.event, p.status, p.amount)),
           count(*) filter (where p.status = 'SUCCESS' and p.event in ('pay','capture'))
      into v_net, v_ok
      from public.payments p
     where p.merchant_order_key = v_order
       and p.mode = p_mode;

    if coalesce(v_ok, 0) = 0 then
      n_missing := n_missing + 1;
      v_issues := v_issues || jsonb_build_object(
        'order_id', v_order, 'issue', 'missing_in_kashier', 'file_amount', v_amount);
    elsif v_amount is not null and v_net is not null and v_net <> v_amount then
      n_mismatch := n_mismatch + 1;
      v_issues := v_issues || jsonb_build_object(
        'order_id', v_order, 'issue', 'amount_mismatch',
        'file_amount', v_amount, 'kashier_amount', v_net);
    else
      n_matched := n_matched + 1;
    end if;
  end loop;

  return jsonb_build_object(
    'mode', p_mode, 'matched', n_matched, 'missing', n_missing,
    'mismatched', n_mismatch, 'issues', v_issues
  );
end;
$$;

revoke all on function public.reconcile_transactions(jsonb, public.kashier_mode) from public, anon;
grant execute on function public.reconcile_transactions(jsonb, public.kashier_mode) to authenticated;
