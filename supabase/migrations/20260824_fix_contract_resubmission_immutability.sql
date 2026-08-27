-- Fixes contract resubmission being silently broken since
-- 20260730_reservation_contracts_immutability.sql.
--
-- ROOT CAUSE
-- ──────────
-- protect_signed_contract_fields() (a BEFORE UPDATE trigger) raises an
-- exception whenever contract_url (or rendered_body/template_id/etc) changes
-- on an UPDATE — with no exception for resubmission. But resubmission's
-- entire purpose is to swap in a corrected, newly-signed PDF, which means
-- changing contract_url. Every resubmission UPDATE from
-- generate-signed-contract has therefore been rejected by Postgres at the
-- trigger level since that migration landed — the edge function's own
-- try/catch reports this back as a failure, and the customer never sees
-- their corrected contract actually saved.
--
-- Separately, before generate-signed-contract's isResubmission check existed
-- (or during earlier debugging), retried submissions with no existing-row
-- guard produced duplicate reservation_contracts rows for the same
-- reservation_id. reservation_contracts was never given a uniqueness
-- constraint, so nothing stopped that. Any reservation with >1 row breaks
-- every .maybeSingle() read in the app (fetchContract in
-- reservation_details.js, admin_reservation_details.js, etc.) with
-- PGRST116 "Results contain N rows" — which is what surfaced as
-- "We couldn't load this reservation."
--
-- THIS MIGRATION
-- ──────────────
-- 1. Redefines protect_signed_contract_fields() to allow contract_url/
--    rendered_body/template fields to change specifically when
--    resubmitted_at is being set/changed in the same UPDATE (the signature
--    generate-signed-contract already writes) — genuinely out-of-band edits
--    (e.g. a manager hand-editing contract_url outside that flow) are still
--    blocked exactly as before.
-- 2. Deduplicates any reservation_id with multiple reservation_contracts
--    rows, keeping the most complete/most-recently-relevant row per
--    reservation and deleting the rest.
-- 3. Adds a real unique constraint on reservation_id so duplicates can never
--    happen again, at the database level, regardless of application bugs.
-- ─────────────────────────────────────────────────────────────────────────────

-- 1. Allow resubmission updates through.
create or replace function public.protect_signed_contract_fields()
returns trigger
language plpgsql
as $$
begin
  -- Legitimate resubmission: generate-signed-contract updates contract_url/
  -- rendered_body/template fields together with resubmitted_at in the same
  -- UPDATE. Recognize that combination and let it through.
  if new.resubmitted_at is not null
     and new.resubmitted_at is distinct from old.resubmitted_at
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

-- 2. Deduplicate. Keep, per reservation_id, whichever row looks most
-- "final": verified over pending, has a contract file over not, was
-- resubmitted over never-resubmitted, breaking any remaining tie by ctid
-- (physical row order — a reasonable proxy for insert recency here since
-- this table is essentially append/patch-only).
with ranked as (
  select
    ctid,
    row_number() over (
      partition by reservation_id
      order by
        (review_status = 'verified') desc,
        (contract_url is not null) desc,
        (resubmitted_at is not null) desc,
        ctid desc
    ) as rn
  from public.reservation_contracts
)
delete from public.reservation_contracts rc
using ranked
where rc.ctid = ranked.ctid
  and ranked.rn > 1;

-- 3. Prevent this from ever happening again.
alter table public.reservation_contracts
  drop constraint if exists reservation_contracts_reservation_id_key;
alter table public.reservation_contracts
  add constraint reservation_contracts_reservation_id_key unique (reservation_id);
