-- Fix trg_auto_verify_contract so it also fires on the normal, system-generated
-- contract path.
--
-- Root cause: the original trigger (20260513_auto_verify_contract_trigger.sql)
-- is AFTER UPDATE only. The generate-signed-contract Edge Function creates the
-- reservation_contracts row with a plain INSERT (contract_url already set),
-- so there is no prior row to "update" and the trigger never fires — the
-- automatic signature scan silently never runs for a normal reservation.
-- It only ever fired for the old manual resubmission flow, which used
-- .update(). This migration adds AFTER INSERT and teaches the trigger
-- function to handle the INSERT case (where OLD does not exist).
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
  IF TG_OP = 'INSERT' THEN
    -- Brand new reservation_contracts row (e.g. generate-signed-contract).
    v_is_new_upload := NEW.contract_url IS NOT NULL;
    v_is_resubmit   := false;
  ELSE
    -- Detect the two cases that constitute a "new upload" on an existing row:
    --   1. contract_url set for the first time  (NULL → value)
    --   2. customer resubmitted a corrected contract (resubmitted_at bumped)
    v_is_new_upload := NEW.contract_url IS NOT NULL AND OLD.contract_url IS NULL;
    v_is_resubmit   := NEW.resubmitted_at IS NOT NULL
                       AND (OLD.resubmitted_at IS NULL
                            OR NEW.resubmitted_at <> OLD.resubmitted_at);
  END IF;

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

DROP TRIGGER IF EXISTS trg_auto_verify_contract ON reservation_contracts;

CREATE TRIGGER trg_auto_verify_contract
AFTER INSERT OR UPDATE ON reservation_contracts
FOR EACH ROW
EXECUTE FUNCTION auto_verify_contract_on_upload();

-- Note: this only fixes the trigger going forward. Existing reservation_contracts
-- rows that were inserted before this migration (and never scanned) will stay
-- "not yet scanned" until re-uploaded, or you manually re-POST them to the
-- verify-contract Edge Function.
