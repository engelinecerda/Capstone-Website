-- ID-vs-signature verification now runs AFTER the reservation is submitted.
--
-- Before: the browser called `verify-id-signature` BEFORE inserting the
-- reservation, so a mismatch blocked the booking from ever being created, and
-- the contract was auto-approved separately by `verify-contract` (a Vision scan
-- that only checks "is there handwriting on the page", never who wrote it).
--
-- After: the customer submits the reservation with the e-signature AND a photo
-- of their ID in one go. `generate-signed-contract` creates the reservation's
-- contract, compares the ID's signature with the e-signature (Gemini vision),
-- and then:
--   * match     -> contract review_status = 'verified' (approved)
--   * no match  -> contract STAYS 'pending_review', the customer is notified
--                  and asked to re-upload their ID or re-sign from their
--                  reservation page
--
-- This migration adds the state needed for that:
--   1. reservation_contracts.id_check_status / id_check_attempts / id_checked_at
--   2. replace_pending_contract() — the one narrow, service-role-only way to
--      swap in a re-signed PDF while the contract is still pending
--   3. protect_signed_contract_fields() honours that RPC and nothing else
--
-- Nothing is stored about the ID itself (same privacy rule as before): only the
-- verdict, the attempt count and a timestamp.
-- ─────────────────────────────────────────────────────────────────────────────

-- 1. Check state -------------------------------------------------------------
-- id_check_status:
--   NULL               no ID check applies (older contracts, or ID check off) —
--                      the legacy flow (verify-contract scan / manual review)
--   'checking'         set at insert so verify-contract knows to stand aside
--                      while the ID comparison is running
--   'matched'          signatures agree -> contract verified
--   'mismatch'         both readable, but they look like different signatures
--   'no_id_signature'  no handwritten signature visible on the ID photo
--   'unclear_id'       ID photo too blurry/dark/cropped
--   'unclear_signature' the drawn signature is too small/scribbled
--   'error'            the check itself failed (service trouble) — a person
--                      reviews the contract manually; not the customer's fault
alter table public.reservation_contracts
  add column if not exists id_check_status   text,
  add column if not exists id_check_attempts integer not null default 0,
  add column if not exists id_checked_at     timestamptz;

alter table public.reservation_contracts
  drop constraint if exists reservation_contracts_id_check_status_check;
alter table public.reservation_contracts
  add constraint reservation_contracts_id_check_status_check
  check (id_check_status is null or id_check_status in (
    'checking', 'matched', 'mismatch', 'no_id_signature',
    'unclear_id', 'unclear_signature', 'error'
  ));

-- 2. Controlled replacement of a pending contract ---------------------------
-- Used only by generate-signed-contract's re-sign path, and only after the new
-- signature has already matched the ID. Granted to service_role alone, so no
-- browser session (customer or manager) can call it through the client SDK.
create or replace function public.replace_pending_contract(
  p_reservation_id uuid,
  p_contract_url   text,
  p_rendered_body  text,
  p_page_count     integer
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Transaction-local flag read by protect_signed_contract_fields() below.
  perform set_config('app.contract_replace', 'on', true);

  update public.reservation_contracts
     set contract_url  = p_contract_url,
         rendered_body = p_rendered_body,
         page_count    = p_page_count
   where reservation_id = p_reservation_id
     and review_status  = 'pending_review';

  if not found then
    raise exception 'replace_pending_contract: no pending contract for reservation %', p_reservation_id;
  end if;
end;
$$;

revoke all on function public.replace_pending_contract(uuid, text, text, integer) from public;
revoke all on function public.replace_pending_contract(uuid, text, text, integer) from anon, authenticated;
grant execute on function public.replace_pending_contract(uuid, text, text, integer) to service_role;

-- 3. Immutability: unchanged, except for the RPC above -----------------------
create or replace function public.protect_signed_contract_fields()
returns trigger
language plpgsql
as $$
begin
  -- Only replace_pending_contract() sets this, and only on a pending contract.
  if coalesce(current_setting('app.contract_replace', true), '') = 'on'
     and old.review_status = 'pending_review'
     and new.reservation_id        is not distinct from old.reservation_id
     and new.template_id           is not distinct from old.template_id
     and new.template_version_no   is not distinct from old.template_version_no
     and new.contract_type         is not distinct from old.contract_type
  then
    return new;
  end if;

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

-- Notes
-- * trg_auto_verify_contract is intentionally NOT dropped. verify-contract now
--   skips any contract whose id_check_status is not NULL, so it only handles
--   contracts submitted without an ID check (older rows / ID check switched
--   off in js/reservations.js).
-- * Customers can already read their own reservation_contracts row, so the
--   reservation page can read id_check_status without a new policy. They have
--   no UPDATE access to it.
