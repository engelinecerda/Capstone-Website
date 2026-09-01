-- Addresses the Supabase "Disk IO Budget" warning email (2026-08-30).
-- Root cause confirmed directly against the live DB, not guessed: the
-- apply-scheduled-maintenance-mode pg_cron job runs every 5 minutes
-- (*/5 * * * *) and has fired 8,741 times since 2026-07-31 with zero
-- automatic cleanup of its own run history. cron.job_run_details had grown
-- to 9,854 rows / ~1.9MB — the single largest table in the database,
-- bigger than all real app data combined — and pg_cron does not prune this
-- table on its own. Continuous 5-minute writes for a month line up exactly
-- with the ascending week-long Disk IO trend in the project's metrics
-- dashboard (not a one-day spike from testing).
--
-- Also drops the dead legacy `auto_verify_contract` trigger on
-- reservation_contracts (flagged earlier the same day while diagnosing the
-- contract signature scanner — see supabase/migrations/20260828c_fix_pg_net_
-- schema_name.sql's summary): a Database-Webhook-style trigger, superseded
-- by trg_auto_verify_contract/auto_verify_contract_on_upload(), that still
-- fires on every reservation_contracts UPDATE with a hardcoded empty body
-- and always fails (confirmed via net._http_response: reservation_id and
-- contract_url are required). Pure wasted writes for zero benefit.
-- ─────────────────────────────────────────────────────────────────────────────

-- 1. One-time cleanup: prune existing cron job-run history, keeping the
--    last 3 days for anyone debugging a recent run.
delete from cron.job_run_details
where end_time < now() - interval '3 days';

-- 2. Ongoing retention: prune job-run history daily so this can't silently
--    balloon again. Runs at 03:00 UTC, off-hours for this project.
select cron.schedule(
  'cleanup-cron-job-run-details',
  '0 3 * * *',
  $$delete from cron.job_run_details where end_time < now() - interval '3 days';$$
);

-- 3. Drop the dead legacy contract-verification trigger. The real,
--    working path (trg_auto_verify_contract -> auto_verify_contract_on_
--    upload(), fixed earlier today) is unaffected — this only removes the
--    superseded Database Webhook trigger that never succeeds.
drop trigger if exists auto_verify_contract on public.reservation_contracts;

-- Verify with (run as separate queries):
--   select count(*) from cron.job_run_details;
--   select jobname, schedule from cron.job where jobname = 'cleanup-cron-job-run-details';
--   select tgname from pg_trigger where tgrelid = 'public.reservation_contracts'::regclass and not tgisinternal;
