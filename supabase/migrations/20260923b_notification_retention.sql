-- Notification retention: notifications has no expiry and fans out one row
-- PER ADMIN/MANAGER on nearly every customer-facing event (new reservation,
-- cancellation request, contract submitted, payment submitted — see
-- 20260513_create_notifications.sql's triggers) plus one row per customer
-- on every status change. That fan-out makes it the next largest unbounded
-- log-style table after audit_log. Same fix, same pattern as
-- 20260923_audit_log_retention.sql: a configurable window in
-- system_settings, enforced automatically by pg_cron, plus an immediate
-- one-time purge to reclaim space now.
--
-- Default: 90 days (shorter than audit_log's 180 — these are transient UI
-- alerts, not a compliance/audit record, so less history needs to be kept).
-- Applies regardless of is_read, same as audit_log's age-only cutoff.
-- ─────────────────────────────────────────────────────────────────────────────

-- 1. Retention setting (admin-configurable later via a plain UPDATE — see
--    the query at the bottom of this file).
INSERT INTO public.system_settings (setting_key, setting_value, setting_category, setting_description)
VALUES (
  'notification_retention_days',
  '{"days": 90}',
  'notifications',
  'Number of days to keep notifications entries before automatic deletion.'
)
ON CONFLICT (setting_key) DO NOTHING;

-- 2. Purge function. SECURITY DEFINER so it can run unattended under
--    pg_cron (no auth.uid() in that context); when called by an
--    authenticated session instead, it requires the admin role, same guard
--    as purge_expired_audit_logs().
CREATE OR REPLACE FUNCTION public.purge_expired_notifications()
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
    RAISE EXCEPTION 'Only admins can purge notifications';
  END IF;

  SELECT (setting_value::jsonb ->> 'days')::integer
    INTO v_days
    FROM public.system_settings
    WHERE setting_key = 'notification_retention_days';

  IF v_days IS NULL OR v_days <= 0 THEN
    v_days := 90;
  END IF;

  DELETE FROM public.notifications
  WHERE created_at < now() - (v_days || ' days')::interval;

  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted;
END;
$$;

GRANT EXECUTE ON FUNCTION public.purge_expired_notifications() TO authenticated;

-- 3. Ongoing enforcement: daily at 04:15 UTC — staggered 15 minutes after
--    purge-expired-audit-logs (04:00) so the two don't contend.
SELECT cron.schedule(
  'purge-expired-notifications',
  '15 4 * * *',
  $$SELECT public.purge_expired_notifications();$$
);

-- 4. One-time immediate purge, run as this migration executes, so storage
--    is reclaimed right away rather than at the next 04:15 UTC tick.
SELECT public.purge_expired_notifications();

-- Verify with (run as separate queries):
--   select * from public.system_settings where setting_key = 'notification_retention_days';
--   select count(*) from public.notifications;
--   select jobname, schedule from cron.job where jobname = 'purge-expired-notifications';
--
-- To change the retention window later:
--   update public.system_settings
--   set setting_value = '{"days": 30}'
--   where setting_key = 'notification_retention_days';
