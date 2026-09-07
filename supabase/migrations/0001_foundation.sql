-- 0001_foundation.sql
-- Extensions, private schema, shared enums and helper functions.
-- Everything the rest of the schema builds on.

create extension if not exists pgcrypto with schema extensions;
create extension if not exists pg_cron;

-- `app` holds internal machinery that must never be reachable through PostgREST.
create schema if not exists app;
revoke all on schema app from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------------

-- Kashier transaction events. Operations, not outcomes.
create type public.kashier_txn_event as enum (
  'pay', 'capture', 'authorize', 'refund', 'void', 'reversal'
);

-- Kashier transfer (payout) events. Statuses, not operations.
create type public.kashier_transfer_event as enum (
  'INITIATED', 'TRANSFERRED', 'FAILED'
);

-- data.status on a transaction payload.
create type public.txn_status as enum (
  'SUCCESS', 'FAILURE', 'PENDING', 'INITIATED',
  'EXPIRED', 'CANCEL', 'REVOKED', 'UNKNOWN'
);

create type public.kashier_mode as enum ('test', 'live');

-- ---------------------------------------------------------------------------
-- Helper functions
-- ---------------------------------------------------------------------------

-- Order ids arrive from two independent systems (ukkera and Kashier) that may
-- differ in case and whitespace. Every comparison goes through this.
create or replace function app.normalize_order_id(p text)
returns text
language sql
immutable
parallel safe
set search_path = ''
as $$
  select nullif(upper(btrim(p)), '')
$$;

-- Coerce an arbitrary status string to the enum without ever raising: unknown
-- values from a future Kashier release must not break ingestion.
create or replace function app.to_txn_status(p text)
returns public.txn_status
language plpgsql
immutable
parallel safe
set search_path = ''
as $$
begin
  return upper(btrim(p))::public.txn_status;
exception when others then
  return 'UNKNOWN'::public.txn_status;
end;
$$;

-- Monotonic ranking so out-of-order deliveries can never downgrade a
-- transaction that already reached a more advanced state.
-- Webhooks are at-least-once and unordered; this is the guard that makes the
-- projection safe to replay in any sequence.
create or replace function app.status_rank(p public.txn_status)
returns int
language sql
immutable
parallel safe
set search_path = ''
as $$
  select case p
    when 'UNKNOWN'   then 0
    when 'INITIATED' then 1
    when 'PENDING'   then 2
    when 'EXPIRED'   then 3
    when 'CANCEL'    then 3
    when 'REVOKED'   then 3
    when 'FAILURE'   then 4
    when 'SUCCESS'   then 5
  end
$$;

-- Egyptian mobile numbers arrive as 01012345678, +201012345678, 201012345678,
-- sometimes with spaces or Arabic-Indic digits. Normalise to bare local form
-- so students can be matched across ukkera webhook and CSV exports.
create or replace function app.normalize_phone(p text)
returns text
language plpgsql
immutable
parallel safe
set search_path = ''
as $$
declare
  d text;
begin
  if p is null then return null; end if;

  -- Fold Arabic-Indic (U+0660..U+0669) and Eastern Arabic-Indic (U+06F0..U+06F9)
  -- digits down to ASCII before stripping.
  d := translate(p, '٠١٢٣٤٥٦٧٨٩۰۱۲۳۴۵۶۷۸۹', '01234567890123456789');
  d := regexp_replace(d, '[^0-9]', '', 'g');

  if d = '' then return null; end if;
  if d like '00201%' then d := substr(d, 4); end if;   -- 00201... -> 201...
  if d like '201%'   then d := '0' || substr(d, 3); end if; -- 201... -> 01...
  if length(d) = 10 and d like '1%' then d := '0' || d; end if; -- 1012345678 -> 01012345678

  return d;
end;
$$;

-- updated_at maintenance.
create or replace function app.touch_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;
