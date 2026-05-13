-- Auto-verify signed contracts using the verify-contract Edge Function.
--
-- When a customer uploads a signed contract (contract_url is set for the first
-- time, or a replacement is submitted via resubmitted_at), this trigger calls
-- the verify-contract Edge Function via HTTP using pg_net.  The function uses
-- GCP Vision to detect a handwritten signature.  If found, it automatically
-- sets review_status = 'verified' and advances the reservation to
-- 'for_finalization', removing the need for manual admin review.
--
-- SETUP REQUIRED before running this migration:
--   Run the following two statements once in the SQL editor to store your
--   project credentials as database settings (replace the placeholders):
--
--     ALTER DATABASE postgres
--       SET app.settings.supabase_url = 'https://<your-project-ref>.supabase.co';
--
--     ALTER DATABASE postgres
--       SET app.settings.service_role_key = '<your-service-role-key>';
--
--   Both values are in: Supabase Dashboard → Project Settings → API.
-- ─────────────────────────────────────────────────────────────────────────────

-- pg_net ships with every Supabase project and lets PostgreSQL make HTTP calls.
CREATE EXTENSION IF NOT EXISTS pg_net;

-- ─────────────────────────────────────────────────────────────────────────────
-- Trigger function
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION auto_verify_contract_on_upload()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_supabase_url  text;
  v_service_key   text;
  v_is_new_upload boolean;
  v_is_resubmit   boolean;
BEGIN
  -- Detect the two cases that constitute a "new upload":
  --   1. contract_url set for the first time  (NULL → value)
  --   2. customer resubmitted a corrected contract (resubmitted_at bumped)
  v_is_new_upload := NEW.contract_url IS NOT NULL AND OLD.contract_url IS NULL;
  v_is_resubmit   := NEW.resubmitted_at IS NOT NULL
                     AND (OLD.resubmitted_at IS NULL
                          OR NEW.resubmitted_at <> OLD.resubmitted_at);

  IF NOT (v_is_new_upload OR v_is_resubmit) THEN
    RETURN NEW;
  END IF;

  -- Read project credentials stored via ALTER DATABASE SET
  v_supabase_url := current_setting('app.settings.supabase_url', true);
  v_service_key  := current_setting('app.settings.service_role_key', true);

  IF v_supabase_url IS NULL OR v_supabase_url = ''
     OR v_service_key IS NULL OR v_service_key = '' THEN
    RAISE WARNING
      'auto_verify_contract: app.settings.supabase_url or service_role_key not configured — skipping auto-verify for reservation %',
      NEW.reservation_id;
    RETURN NEW;
  END IF;

  -- Fire-and-forget HTTP POST to the Edge Function.
  -- pg_net queues the request asynchronously; the trigger returns immediately.
  PERFORM pg_net.http_post(
    url     := v_supabase_url || '/functions/v1/verify-contract',
    headers := jsonb_build_object(
      'Content-Type',  'application/json',
      'Authorization', 'Bearer ' || v_service_key
    ),
    body    := jsonb_build_object(
      'reservation_id', NEW.reservation_id,
      'contract_url',   NEW.contract_url
    )::text
  );

  RETURN NEW;
END;
$$;

-- Drop old version if re-running migration
DROP TRIGGER IF EXISTS trg_auto_verify_contract ON reservation_contracts;

CREATE TRIGGER trg_auto_verify_contract
AFTER UPDATE ON reservation_contracts
FOR EACH ROW
EXECUTE FUNCTION auto_verify_contract_on_upload();
