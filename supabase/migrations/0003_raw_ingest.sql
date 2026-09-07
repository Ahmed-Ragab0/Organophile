-- 0003_raw_ingest.sql
-- Append-only landing tables for every webhook delivery, plus the safe
-- coercion helpers the projections rely on.
--
-- Dedupe key is sha256 of the exact request body, NOT (transaction_id, event).
-- That distinction matters: Kashier legitimately sends `pay`/PENDING followed
-- by `pay`/SUCCESS for the same transaction. Keying on (transaction_id, event)
-- would silently discard the second one and freeze the payment as pending.
-- A true retry is byte-identical, so hashing the body dedupes retries while
-- preserving genuine state transitions.

-- ---------------------------------------------------------------------------
-- Safe coercion helpers — ingestion must never fail on a surprising value
-- ---------------------------------------------------------------------------

create or replace function app.to_numeric(p text)
returns numeric
language plpgsql
immutable
parallel safe
set search_path = ''
as $$
begin
  if p is null or btrim(p) = '' then return null; end if;
  return btrim(p)::numeric;
exception when others then
  return null;
end;
$$;

create or replace function app.to_timestamptz(p text)
returns timestamptz
language plpgsql
immutable
parallel safe
set search_path = ''
as $$
begin
  if p is null or btrim(p) = '' then return null; end if;
  return btrim(p)::timestamptz;
exception when others then
  return null;
end;
$$;

-- ---------------------------------------------------------------------------
-- Raw landing tables
-- ---------------------------------------------------------------------------

create type app.ingest_state as enum ('pending', 'processed', 'failed', 'ignored');

create table public.kashier_events_raw (
  id              uuid primary key default gen_random_uuid(),

  event           text,
  resource_type   text not null default 'transaction'
                    check (resource_type in ('transaction','transfer','unknown')),
  mode            public.kashier_mode not null default 'live',
  -- 'configured' = a webhook registered in the dashboard.
  -- 'server'     = the per-order serverWebhook (webhookId null on Kashier side).
  source          text not null default 'configured'
                    check (source in ('configured','server','manual_replay')),

  payload         jsonb not null,
  body_sha256     text not null,

  signature_valid boolean not null default false,
  signature_note  text,

  received_at     timestamptz not null default now(),

  state           app.ingest_state not null default 'pending',
  processed_at    timestamptz,
  process_attempts int not null default 0,
  process_error   text,
  duplicate_count int not null default 0,
  last_duplicate_at timestamptz,

  constraint kashier_events_raw_body_uniq unique (body_sha256)
);

-- Drives the retry sweeper; only unfinished rows are indexed.
create index kashier_raw_pending_idx on public.kashier_events_raw (received_at)
  where state in ('pending','failed');
create index kashier_raw_received_idx on public.kashier_events_raw (received_at desc);

create table public.ukkera_events_raw (
  id              uuid primary key default gen_random_uuid(),
  payload         jsonb not null,
  body_sha256     text not null,
  received_at     timestamptz not null default now(),
  state           app.ingest_state not null default 'pending',
  processed_at    timestamptz,
  process_attempts int not null default 0,
  process_error   text,
  duplicate_count int not null default 0,
  last_duplicate_at timestamptz,
  constraint ukkera_events_raw_body_uniq unique (body_sha256)
);

create index ukkera_raw_pending_idx on public.ukkera_events_raw (received_at)
  where state in ('pending','failed');
create index ukkera_raw_received_idx on public.ukkera_events_raw (received_at desc);

-- ---------------------------------------------------------------------------
-- Rejected deliveries — anything that failed signature/auth or could not be
-- parsed. Kept separately so the main log stays clean and so a spike here is
-- an obvious security signal.
-- ---------------------------------------------------------------------------

create table public.webhook_rejections (
  id          uuid primary key default gen_random_uuid(),
  endpoint    text not null,
  reason      text not null,
  detail      text,
  body_sha256 text,
  body_excerpt text,
  received_at timestamptz not null default now()
);

create index webhook_rejections_received_idx on public.webhook_rejections (received_at desc);
create index webhook_rejections_reason_idx   on public.webhook_rejections (reason);
