-- ═══════════════════════════════════════════════════════════════════════════
-- Manager countersignature
--
-- Until now only the customer signed the contract. The manager now signs too,
-- as part of Approve:
--   * the customer signs, the ID is verified (existing flow);
--   * the manager draws a signature and confirms with their password;
--   * the countersign-contract edge function appends a countersignature page
--     to the customer-signed PDF and stores the result in countersigned_url;
--   * only then can the reservation be approved.
--
-- The customer-signed PDF (contract_url) is never changed, so it stays as the
-- audit copy. The fully signed copy lives in countersigned_url.
--
-- Declining a reservation voids its contract (voided_at); the row is kept.
-- ═══════════════════════════════════════════════════════════════════════════

-- 1. Columns ------------------------------------------------------------------
alter table public.reservation_contracts
  add column if not exists countersigned_url        text,
  add column if not exists countersigned_at         timestamptz,
  add column if not exists countersigned_by         uuid,
  add column if not exists countersigned_by_name    text,
  add column if not exists countersigned_page_count integer,
  add column if not exists voided_at                timestamptz;

-- 2. Countersignature fields can only be written by the RPC / void trigger below,
--    never directly (a manager's RLS update policy would otherwise allow it).
create or replace function public.protect_countersignature_fields()
returns trigger
language plpgsql
as $$
begin
  if coalesce(current_setting('app.contract_countersign', true), '') <> 'on'
     and (   new.countersigned_url        is distinct from old.countersigned_url
          or new.countersigned_at         is distinct from old.countersigned_at
          or new.countersigned_by         is distinct from old.countersigned_by
          or new.countersigned_by_name    is distinct from old.countersigned_by_name
          or new.countersigned_page_count is distinct from old.countersigned_page_count
          or new.voided_at                is distinct from old.voided_at)
  then
    raise exception 'reservation_contracts: countersignature fields cannot be changed directly';
  end if;
  return new;
end;
$$;

drop trigger if exists protect_countersignature_fields on public.reservation_contracts;
create trigger protect_countersignature_fields
  before update on public.reservation_contracts
  for each row execute function public.protect_countersignature_fields();

-- 3. Recording a countersignature (service role only) ----------------------------
create or replace function public.record_contract_countersignature(
  p_reservation_id    uuid,
  p_countersigned_url text,
  p_page_count        integer,
  p_signer_id         uuid,
  p_signer_name       text,
  p_signature_url     text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_contract public.reservation_contracts%rowtype;
begin
  select * into v_contract
    from public.reservation_contracts
   where reservation_id = p_reservation_id
   for update;

  if not found then
    raise exception 'There is no contract for this reservation.';
  end if;
  if v_contract.voided_at is not null then
    raise exception 'This contract was voided.';
  end if;
  if v_contract.countersigned_at is not null then
    raise exception 'This contract has already been countersigned.';
  end if;
  if not (lower(coalesce(v_contract.review_status, '')) = 'verified' or v_contract.verified_date is not null) then
    raise exception 'The contract must be verified before it can be countersigned.';
  end if;

  perform set_config('app.contract_countersign', 'on', true);

  update public.reservation_contracts
     set countersigned_url        = p_countersigned_url,
         countersigned_at         = now(),
         countersigned_by         = p_signer_id,
         countersigned_by_name    = p_signer_name,
         countersigned_page_count = p_page_count
   where reservation_id = p_reservation_id;

  insert into public.contract_signatures
    (reservation_id, signer_role, signer_name, signature_type, signature_image_url, signed_at)
  values
    (p_reservation_id, 'manager', p_signer_name, 'drawn', p_signature_url, now());
end;
$$;

revoke all on function public.record_contract_countersignature(uuid, text, integer, uuid, text, text) from public;
revoke all on function public.record_contract_countersignature(uuid, text, integer, uuid, text, text) from anon, authenticated;
grant execute on function public.record_contract_countersignature(uuid, text, integer, uuid, text, text) to service_role;

-- 4. Approval requires a countersigned contract ----------------------------------
-- Only the first approval (pending -> approved) is guarded, so reschedules and
-- cancellation reversals that put an already-approved reservation back to
-- approved are unaffected. A reservation without any contract row is left to
-- the existing checks (the screen already requires a verified contract).
create or replace function public.require_countersignature_for_approval()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if lower(coalesce(new.status, '')) = 'approved'
     and lower(coalesce(old.status, '')) = 'pending'
     and exists (
       select 1 from public.reservation_contracts c
        where c.reservation_id = new.reservation_id
          and c.countersigned_at is null
     )
  then
    raise exception 'The contract must be countersigned by a manager before this reservation can be approved.';
  end if;
  return new;
end;
$$;

drop trigger if exists reservations_require_countersignature on public.reservations;
create trigger reservations_require_countersignature
  before update of status on public.reservations
  for each row execute function public.require_countersignature_for_approval();

-- 5. Declining voids the contract -------------------------------------------------
create or replace function public.void_contract_on_decline()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if lower(coalesce(new.status, '')) = 'declined'
     and lower(coalesce(old.status, '')) is distinct from 'declined'
  then
    perform set_config('app.contract_countersign', 'on', true);
    update public.reservation_contracts
       set voided_at = now()
     where reservation_id = new.reservation_id
       and countersigned_at is null
       and voided_at is null;
  end if;
  return new;
end;
$$;

drop trigger if exists reservations_void_contract_on_decline on public.reservations;
create trigger reservations_void_contract_on_decline
  after update of status on public.reservations
  for each row execute function public.void_contract_on_decline();

-- ── Verify after applying ────────────────────────────────────────────────────
--   select column_name from information_schema.columns
--    where table_name = 'reservation_contracts' and column_name like 'countersigned%';
--   select tgname from pg_trigger where tgname in
--     ('reservations_require_countersignature', 'reservations_void_contract_on_decline',
--      'protect_countersignature_fields');
