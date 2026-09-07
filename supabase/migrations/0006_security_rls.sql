-- 0006_security_rls.sql
-- Row level security, role grants, and the service-role-only ingest surface.
--
-- Threat model for this project:
--   * The anon key ships to the browser and must be able to read NOTHING.
--   * Exactly one human (the account owner) may read the data. Payment rows
--     carry cardholder names, masked PANs and student phone numbers.
--   * Derived tables (payments, payouts, raw events) are never writable from
--     the dashboard; they only ever change through the webhook path, which
--     runs as service_role and bypasses RLS.

-- ---------------------------------------------------------------------------
-- Who is an admin
-- ---------------------------------------------------------------------------

create table public.admin_users (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  email      text,
  created_at timestamptz not null default now()
);

-- STABLE + security definer so the policy can read admin_users without
-- recursing into admin_users' own RLS.
create or replace function app.is_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1 from public.admin_users a where a.user_id = auth.uid())
$$;

grant execute on function app.is_admin() to authenticated;

-- ---------------------------------------------------------------------------
-- Enable RLS everywhere in public
-- ---------------------------------------------------------------------------

do $$
declare t text;
begin
  foreach t in array array[
    'students','courses','packages','subscriptions','payments','payouts',
    'expenses','payment_subscription_overrides','admin_users',
    'kashier_events_raw','ukkera_events_raw','webhook_rejections'
  ] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('alter table public.%I force row level security', t);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- Grants: anon gets nothing at all
-- ---------------------------------------------------------------------------

revoke all on all tables    in schema public from anon;
revoke all on all functions in schema public from anon;
revoke all on all sequences in schema public from anon;
alter default privileges in schema public revoke all on tables    from anon;
alter default privileges in schema public revoke all on functions from anon;

-- Read-only for the dashboard user. Writes are policy-gated below.
grant select on
  public.students, public.courses, public.packages, public.subscriptions,
  public.payments, public.payouts, public.expenses,
  public.payment_subscription_overrides, public.admin_users,
  public.kashier_events_raw, public.ukkera_events_raw, public.webhook_rejections
to authenticated;

-- Tables the dashboard may edit.
grant insert, update, delete on
  public.students, public.courses, public.packages, public.subscriptions,
  public.expenses, public.payment_subscription_overrides
to authenticated;

grant select on
  public.v_payment_matches, public.v_payments_enriched,
  public.v_unmatched_payments, public.v_unpaid_subscriptions,
  public.v_revenue_daily, public.v_expenses_daily, public.v_profit_daily,
  public.v_revenue_monthly, public.v_payout_summary,
  public.v_ingest_health, public.v_dashboard_kpis
to authenticated;

-- ---------------------------------------------------------------------------
-- Policies
-- ---------------------------------------------------------------------------

-- Read-only for the admin: everything Kashier-derived.
do $$
declare t text;
begin
  foreach t in array array[
    'payments','payouts','kashier_events_raw','ukkera_events_raw','webhook_rejections'
  ] loop
    execute format(
      'create policy %I on public.%I for select to authenticated using (app.is_admin())',
      t || '_admin_read', t);
  end loop;
end $$;

-- Full CRUD for the admin: everything the dashboard owns.
do $$
declare t text;
begin
  foreach t in array array[
    'students','courses','packages','subscriptions','expenses',
    'payment_subscription_overrides'
  ] loop
    execute format(
      'create policy %I on public.%I for all to authenticated
         using (app.is_admin()) with check (app.is_admin())',
      t || '_admin_all', t);
  end loop;
end $$;

-- An admin may see the admin list but never edit it; membership is granted
-- out of band so a compromised session cannot escalate or add accomplices.
create policy admin_users_admin_read on public.admin_users
  for select to authenticated using (app.is_admin());

-- ---------------------------------------------------------------------------
-- Ingest surface for the Edge Functions
-- ---------------------------------------------------------------------------
-- PostgREST only exposes `public`, so the `app.*` ingest functions are
-- unreachable over HTTP by design. These wrappers are the sole entry point and
-- are executable by service_role only.

create or replace function public.ingest_kashier_event(
  p_payload        jsonb,
  p_body_sha256    text,
  p_signature_valid boolean,
  p_mode           public.kashier_mode,
  p_resource_type  text default 'transaction',
  p_source         text default 'configured',
  p_signature_note text default null
) returns jsonb
language sql
security definer
set search_path = ''
as $$
  select app.ingest_kashier_event(
    p_payload, p_body_sha256, p_signature_valid, p_mode,
    p_resource_type, p_source, p_signature_note)
$$;

create or replace function public.ingest_ukkera_event(
  p_payload jsonb,
  p_body_sha256 text
) returns jsonb
language sql
security definer
set search_path = ''
as $$
  select app.ingest_ukkera_event(p_payload, p_body_sha256)
$$;

create or replace function public.record_webhook_rejection(
  p_endpoint text,
  p_reason   text,
  p_detail   text default null,
  p_body_sha256 text default null,
  p_body_excerpt text default null
) returns void
language sql
security definer
set search_path = ''
as $$
  insert into public.webhook_rejections (endpoint, reason, detail, body_sha256, body_excerpt)
  values (p_endpoint, p_reason, p_detail, p_body_sha256, left(coalesce(p_body_excerpt,''), 2000))
$$;

-- Lock the wrappers down to service_role. `public` here is the PUBLIC
-- pseudo-role, not the schema: this revokes the default EXECUTE-to-everyone.
revoke all on function public.ingest_kashier_event(jsonb,text,boolean,public.kashier_mode,text,text,text)
  from public, anon, authenticated;
revoke all on function public.ingest_ukkera_event(jsonb,text) from public, anon, authenticated;
revoke all on function public.record_webhook_rejection(text,text,text,text,text)
  from public, anon, authenticated;

grant execute on function public.ingest_kashier_event(jsonb,text,boolean,public.kashier_mode,text,text,text)
  to service_role;
grant execute on function public.ingest_ukkera_event(jsonb,text) to service_role;
grant execute on function public.record_webhook_rejection(text,text,text,text,text) to service_role;

-- The admin may re-run the sweeper from the dashboard when a projection bug
-- has been fixed; everything else in `app` stays private.
create or replace function public.sweep_failed_events()
returns jsonb
language sql
security definer
set search_path = ''
as $$
  select case when app.is_admin() or auth.role() = 'service_role'
    then app.sweep_failed_events()
    else jsonb_build_object('error','forbidden')
  end
$$;

revoke all on function public.sweep_failed_events() from public, anon;
grant execute on function public.sweep_failed_events() to authenticated, service_role;
