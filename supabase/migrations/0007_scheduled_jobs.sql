-- 0007_scheduled_jobs.sql
-- Background maintenance.
--
-- The sweeper is what makes the "never throw from ingest" contract safe: a
-- delivery whose projection failed sits in `failed` with its full payload
-- intact, and is retried automatically. After a projection bug is fixed, the
-- backlog drains on its own with no manual replay from Kashier.

select cron.schedule(
  'sweep-failed-webhook-events',
  '*/5 * * * *',
  $$ select app.sweep_failed_events(500, 12) $$
);

-- Rejected deliveries are a security signal, not business data. Ninety days is
-- long enough to investigate an incident and short enough that a sustained
-- probe cannot fill the disk.
create or replace function app.purge_old_rejections(p_days int default 90)
returns int
language plpgsql
security definer
set search_path = ''
as $$
declare n int;
begin
  delete from public.webhook_rejections
   where received_at < now() - make_interval(days => p_days);
  get diagnostics n = row_count;
  return n;
end;
$$;

select cron.schedule(
  'purge-old-webhook-rejections',
  '17 3 * * *',
  $$ select app.purge_old_rejections(90) $$
);

-- Raw event payloads are deliberately NOT purged. They are the audit trail for
-- money movement and the only place a delivery can be replayed from.
