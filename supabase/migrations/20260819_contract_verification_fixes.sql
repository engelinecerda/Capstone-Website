-- Fixes for the OCR contract-signature auto-verification pipeline not
-- reliably working. Two root causes found:
--
-- 1. generate-signed-contract uploaded the signed contract PDF to Cloudinary
--    with resource_type 'raw'. verify-contract's toImageUrl() then applied a
--    pg_N page + JPEG-format transformation to that URL — but Cloudinary's
--    page-extraction/format transformations only work on resource_type
--    'image' assets, never 'raw'. That upload-side fix (raw -> image) is a
--    code change (generate-signed-contract/index.ts), not a migration.
--
-- 2. Even with a correct image URL, verify-contract only ever scanned page 1
--    (hardcoded pg_1). buildContractPdf() always draws the signature section
--    last, after the intro/summary/package/venue/terms sections — so on any
--    contract long enough to spill past one page, the signature is never on
--    page 1 and was never seen. This migration adds a page_count column,
--    populated from Cloudinary's own page count at upload time, and teaches
--    the auto-verify trigger to forward it so verify-contract can target the
--    actual last page instead of assuming page 1.
-- ─────────────────────────────────────────────────────────────────────────────

alter table public.reservation_contracts
  add column if not exists page_count integer;

create or replace function auto_verify_contract_on_upload()
returns trigger
language plpgsql
security definer
as $$
declare
  v_supabase_url  text;
  v_service_key   text;
  v_is_new_upload boolean;
  v_is_resubmit   boolean;
begin
  if TG_OP = 'INSERT' then
    v_is_new_upload := NEW.contract_url is not null;
    v_is_resubmit   := false;
  else
    v_is_new_upload := NEW.contract_url is not null and OLD.contract_url is null;
    v_is_resubmit   := NEW.resubmitted_at is not null
                       and (OLD.resubmitted_at is null
                            or NEW.resubmitted_at <> OLD.resubmitted_at);
  end if;

  if not (v_is_new_upload or v_is_resubmit) then
    return NEW;
  end if;

  v_supabase_url := current_setting('app.settings.supabase_url', true);
  v_service_key  := current_setting('app.settings.service_role_key', true);

  if v_supabase_url is null or v_supabase_url = ''
     or v_service_key is null or v_service_key = '' then
    raise warning
      'auto_verify_contract: app.settings.supabase_url or service_role_key not configured — skipping auto-verify for reservation %',
      NEW.reservation_id;
    return NEW;
  end if;

  perform pg_net.http_post(
    url     := v_supabase_url || '/functions/v1/verify-contract',
    headers := jsonb_build_object(
      'Content-Type',  'application/json',
      'Authorization', 'Bearer ' || v_service_key
    ),
    body    := jsonb_build_object(
      'reservation_id', NEW.reservation_id,
      'contract_url',   NEW.contract_url,
      'page_count',     NEW.page_count
    )::text
  );

  return NEW;
end;
$$;

-- Trigger definition itself (AFTER INSERT OR UPDATE, from
-- 20260716_auto_verify_contract_on_insert.sql) is unchanged — only the
-- function body above changed, so no DROP/CREATE TRIGGER needed here.
