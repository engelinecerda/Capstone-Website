-- Audit log retention: audit_log is the single largest contributor to
-- Supabase database storage per the dashboard usage breakdown, and it has
-- no expiry — every logAudit() call (js/audit_logger.js) adds a row
-- forever. This adds a configurable retention window (system_settings,
-- same setting_key/setting_value pattern as backup_retention_days in
-- js/super_admin_backup.js) enforced automatically by pg_cron (already in
-- use for the maintenance-mode job and the 20260830_disk_io_cleanup.sql
-- cron-history prune), plus a one-time purge below to reclaim space now
-- instead of waiting for tonight's first scheduled run.
--
-- Default: 180 days.
-- ─────────────────────────────────────────────────────────────────────────────

-- 1. Retention setting (admin-configurable later via a plain UPDATE — see
--    the query at the bottom of this file).
INSERT INTO public.system_settings (setting_key, setting_value, setting_category, setting_description)
VALUES (
  'audit_log_retention_days',
  '{"days": 180}',
  'audit',
  'Number of days to keep audit_log entries before automatic deletion.'
)
ON CONFLICT (setting_key) DO NOTHING;

-- 2. Purge function. SECURITY DEFINER so it can run unattended under
--    pg_cron (no auth.uid() in that context); when called by an
--    authenticated session instead (e.g. a future admin "purge now"
--    action), it requires the admin role, matching the admin-only write
--    policy on system_settings itself.
CREATE OR REPLACE FUNCTION public.purge_expired_audit_logs()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_days    integer;
  v_deleted integer;
BEGIN
  IF auth.uid() IS NOT NULL AND public.get_my_role() <> 'admin' THEN
    RAISE EXCEPTION 'Only admins can purge audit logs';
  END IF;

  SELECT (setting_value::jsonb ->> 'days')::integer
    INTO v_days
    FROM public.system_settings
    WHERE setting_key = 'audit_log_retention_days';

  IF v_days IS NULL OR v_days <= 0 THEN
    v_days := 180;
  END IF;

  DELETE FROM public.audit_log
  WHERE created_at < now() - (v_days || ' days')::interval;

  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted;
END;
$$;

GRANT EXECUTE ON FUNCTION public.purge_expired_audit_logs() TO authenticated;

-- 3. Ongoing enforcement: daily at 04:00 UTC (off-hours, same convention as
--    the 03:00 cron-history prune in 20260830_disk_io_cleanup.sql).
SELECT cron.schedule(
  'purge-expired-audit-logs',
  '0 4 * * *',
  $$SELECT public.purge_expired_audit_logs();$$
);

-- 4. One-time immediate purge, run as this migration executes, so storage
--    is reclaimed right away rather than at the next 04:00 UTC tick.
SELECT public.purge_expired_audit_logs();

-- Verify with (run as separate queries):
--   select * from public.system_settings where setting_key = 'audit_log_retention_days';
--   select count(*) from public.audit_log;
--   select jobname, schedule from cron.job where jobname = 'purge-expired-audit-logs';
--
-- To change the retention window later:
--   update public.system_settings
--   set setting_value = '{"days": 90}'
--   where setting_key = 'audit_log_retention_days';
