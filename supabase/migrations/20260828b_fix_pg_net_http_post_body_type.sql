-- Fixes a second, more dangerous bug uncovered while fixing the missing
-- app_config.settings values (see 20260828_configure_auto_verify_app_
-- settings.sql): auto_verify_contract_on_upload() calls pg_net.http_post()
-- with `body := jsonb_build_object(...)::text`, but this project's
-- net.http_post signature is:
--
--   http_post(url text, body jsonb DEFAULT '{}', params jsonb DEFAULT '{}',
--              headers jsonb DEFAULT '{...}', timeout_milliseconds int DEFAULT 5000)
--
-- There is no text-accepting overload — `body::text` has always raised
-- "function net.http_post(...) does not exist". Confirmed directly:
--   select pg_get_function_arguments(oid) from pg_proc
--   where proname = 'http_post' and pronamespace = 'net'::regnamespace;
-- returns exactly one overload, with `body jsonb`.
--
-- This call sat unreached before now: with app_config.settings empty, the
-- function always returned early at the "not configured" check. Now that
-- those settings are populated, every new contract upload would reach this
-- broken call — and because it's not wrapped in exception handling, the
-- error would propagate out of the trigger and abort the entire INSERT/
-- UPDATE on reservation_contracts, breaking contract uploads outright
-- instead of just skipping the scan. Fixed by dropping the ::text cast, and
-- wrapping the pg_net call in its own exception handler so a future pg_net/
-- network hiccup degrades to "scan skipped" (like the missing-settings case
-- already does) instead of failing the customer's upload.
--
-- Verified against production before writing this: calling net.http_post
-- with body as jsonb (no cast) against verify-contract, using a throwaway
-- reservation_id, returned HTTP 200 via net._http_response.
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function auto_verify_contract_on_upload()
returns trigger
language plpgsql
security definer
as $$
declare
  v_supabase_url  text;
  v_service_key   text;
  v_is_new_upload boolean;
begin
  if TG_OP = 'INSERT' then
    v_is_new_upload := NEW.contract_url is not null;
  else
    v_is_new_upload := NEW.contract_url is not null and OLD.contract_url is null;
  end if;

  if not v_is_new_upload then
    return NEW;
  end if;

  select value into v_supabase_url from app_config.settings where key = 'supabase_url';
  select value into v_service_key  from app_config.settings where key = 'service_role_key';

  if v_supabase_url is null or v_supabase_url = ''
     or v_service_key is null or v_service_key = '' then
    raise warning
      'auto_verify_contract: app_config.settings not configured — skipping auto-verify for reservation %',
      NEW.reservation_id;
    return NEW;
  end if;

  begin
    perform pg_net.http_post(
      url     := v_supabase_url || '/functions/v1/verify-contract',
      body    := jsonb_build_object(
        'reservation_id', NEW.reservation_id,
        'contract_url',   NEW.contract_url,
        'page_count',     NEW.page_count
      ),
      headers := jsonb_build_object(
        'Content-Type',  'application/json',
        'Authorization', 'Bearer ' || v_service_key
      )
    );
  exception when others then
    raise warning
      'auto_verify_contract: pg_net.http_post failed for reservation % — %',
      NEW.reservation_id, SQLERRM;
  end;

  return NEW;
end;
$$;

-- Trigger definition itself is unchanged — only the function body above
-- changed, so no DROP/CREATE TRIGGER needed here.
