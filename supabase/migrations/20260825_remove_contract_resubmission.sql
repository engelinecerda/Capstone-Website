-- Removes the contract resubmission workflow at the database level.
--
-- The application no longer offers a "request resubmission" action (manager
-- side) or a "re-upload corrected contract" flow (customer side) — see the
-- app-code changes in js/admin_contracts.js, js/reservation_details.js,
-- js/reservation_shared.js, and supabase/functions/generate-signed-contract.
-- This migration brings the schema/functions back in line with that:
--
-- 1. Any existing rows sitting in the now-removed 'resubmission_requested'
--    review_status are moved back to 'pending_review' (the state they'd be
--    in if resubmission had never been requested), and any reservation
--    still sitting in the matching 'resubmission_requested' status is moved
--    back to 'pending' so it surfaces for ordinary review again.
-- 2. review_status is constrained back down to just the two states the app
--    now uses: 'pending_review' and 'verified'.
-- 3. auto_verify_contract_on_upload() drops its resubmitted_at detection —
--    generate-signed-contract only ever INSERTs now, so only the INSERT and
--    plain-first-upload cases remain.
-- 4. protect_signed_contract_fields() drops its resubmitted_at exception —
--    signed contract fields (contract_url, rendered_body, template_id,
--    etc.) are unconditionally immutable again, matching the original
--    20260730_reservation_contracts_immutability.sql behavior before
--    resubmission support was added.
-- 5. resubmitted_at is dropped from reservation_contracts.
-- ─────────────────────────────────────────────────────────────────────────────

-- 1. Roll back any in-flight resubmission state.
update public.reservation_contracts
set review_status = 'pending_review'
where review_status = 'resubmission_requested';

update public.reservations
set status = 'pending'
where status = 'resubmission_requested';

-- 2. Tighten the review_status constraint back to two states.
alter table public.reservation_contracts
  drop constraint if exists reservation_contracts_review_status_check;
alter table public.reservation_contracts
  add constraint reservation_contracts_review_status_check
  check (review_status in ('pending_review', 'verified'));

-- 3. auto_verify_contract_on_upload(): drop resubmit detection.
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

-- Trigger definition itself is unchanged — only the function body above
-- changed, so no DROP/CREATE TRIGGER needed here.

-- 4. protect_signed_contract_fields(): drop the resubmission exception,
--    restoring unconditional immutability of signed contract fields.
create or replace function public.protect_signed_contract_fields()
returns trigger
language plpgsql
as $$
begin
  if new.reservation_id        is distinct from old.reservation_id
    or new.template_id         is distinct from old.template_id
    or new.template_version_no is distinct from old.template_version_no
    or new.contract_type       is distinct from old.contract_type
    or new.contract_url        is distinct from old.contract_url
    or new.rendered_body       is distinct from old.rendered_body
  then
    raise exception 'reservation_contracts: signed contract fields are immutable';
  end if;
  return new;
end;
$$;

-- 5. Drop the now-unused resubmitted_at column.
alter table public.reservation_contracts
  drop column if exists resubmitted_at;
