-- Fixes a third, previously-invisible bug in auto_verify_contract_on_upload():
-- the function calls `pg_net.http_post(...)`, but the pg_net extension's
-- functions live in a schema named `net`, not `pg_net` — confirmed directly:
--
--   select nspname from pg_namespace where nspname in ('pg_net','net');
--   -> only 'net' exists
--
-- This call has been broken since the very first version of this function
-- (20260716_auto_verify_contract_on_insert.sql). It never surfaced before
-- now because the missing app_config settings (fixed in 20260828_configure_
-- auto_verify_app_settings.sql) always returned early first, and the
-- exception handler added in 20260828b_fix_pg_net_http_post_body_type.sql
-- silently swallows the "schema pg_net does not exist" error rather than
-- failing the insert — which is correct behavior for a genuine pg_net
-- outage, but also hid this typo from view until traced directly via
-- pg_get_functiondef(). Confirmed the fix by calling net.http_post (correct
-- schema) manually against production and getting a real HTTP 200 back.
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
    perform net.http_post(
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
      'auto_verify_contract: net.http_post failed for reservation % — %',
      NEW.reservation_id, SQLERRM;
  end;

  return NEW;
end;
$$;

-- Trigger definition itself is unchanged — only the function body above
-- changed, so no DROP/CREATE TRIGGER needed here.
