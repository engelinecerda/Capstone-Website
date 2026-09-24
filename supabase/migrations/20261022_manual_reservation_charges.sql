-- Manual Charge for Special Requests — lets a manager add an ad-hoc priced
-- line to an existing reservation for an agreed special request (e.g. a
-- custom setup the café accepted informally). Deliberately NOT modeled on
-- reservation_extensions/reservation_additional_head_requests
-- (20260920/20261020) even though those are the closest precedents in this
-- codebase, because this feature works the opposite way on purpose: those
-- are flat fees tracked entirely OUTSIDE the base balance (excluded from
-- reservation_payment_summary's total_paid, never touching total_price —
-- paid once, done, invisible to "remaining balance" afterward). A manual
-- charge must do the opposite: inflate the EFFECTIVE total the base
-- balance (reservation_fee/down_payment/full_payment/partial_payment) is
-- computed against, so "remaining balance" goes up immediately and the
-- customer pays it down through the exact same existing flow — no new
-- payment_type, no request/hold/approval lifecycle. reservations.total_price
-- itself is never written to (preserves contract snapshotting — the signed
-- contract stays frozen at its signed total, per explicit instruction);
-- every consumer of "the total" is instead updated to read total_price +
-- sum(non-voided charges) via one shared helper.

-- ============================================================
-- 1. reservation_charges
-- ============================================================
create table if not exists public.reservation_charges (
  charge_id      uuid primary key default gen_random_uuid(),
  reservation_id uuid not null references public.reservations(reservation_id) on delete cascade,
  label          text not null check (length(trim(label)) > 0),
  amount         numeric(12,2) not null check (amount > 0),
  note           text,
  added_by       uuid references auth.users(id) on delete set null,
  voided         boolean not null default false,
  voided_by      uuid references auth.users(id) on delete set null,
  voided_at      timestamptz,
  void_reason    text,
  created_at     timestamptz not null default now()
);

create index if not exists reservation_charges_reservation_id_idx
  on public.reservation_charges (reservation_id);

-- ── RLS ──────────────────────────────────────────────────────────────────
-- No UPDATE/DELETE policy for any role, on purpose — a charge is either
-- inserted (add_reservation_charge below, or a direct RLS-gated insert —
-- both plain manager actions with no approval step, per spec) or voided
-- through void_reservation_charge() (a SECURITY DEFINER function, which
-- bypasses RLS entirely), never edited or hard-deleted. This mirrors the
-- reason reservation_extensions/reservation_additional_head_requests also
-- have no UPDATE policy: every status/state transition happens inside a
-- guarded function, not a raw client update.
alter table public.reservation_charges enable row level security;

drop policy if exists "customer_select_own_reservation_charges" on public.reservation_charges;
create policy "customer_select_own_reservation_charges"
  on public.reservation_charges for select
  using (
    exists (
      select 1 from public.reservations r
      where r.reservation_id = reservation_charges.reservation_id
        and r.user_id = auth.uid()
    )
  );

drop policy if exists "staff_select_all_reservation_charges" on public.reservation_charges;
create policy "staff_select_all_reservation_charges"
  on public.reservation_charges for select
  using (public.get_my_role() in ('manager', 'admin', 'staff'));

drop policy if exists "manager_insert_reservation_charge" on public.reservation_charges;
create policy "manager_insert_reservation_charge"
  on public.reservation_charges for insert
  with check (
    public.get_my_role() in ('manager', 'admin')
    and added_by = auth.uid()
  );

grant select, insert on public.reservation_charges to authenticated;

-- ============================================================
-- 2. get_reservation_effective_total() — the ONE place "what does this
--    reservation actually total, including agreed extras" is computed.
--    Used by validate_payment_submission() below; reservation_payment_
--    summary (section 3) computes the same thing inline via its own
--    LATERAL join instead of calling this per-row (avoids a function call
--    per view row) but must stay logically identical to it — both are
--    reproduced together in this file specifically so they can't drift.
-- ============================================================
create or replace function public.get_reservation_effective_total(p_reservation_id uuid)
returns numeric
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(r.total_price, 0) + coalesce((
    select sum(c.amount)
    from public.reservation_charges c
    where c.reservation_id = p_reservation_id
      and c.voided = false
  ), 0)
  from public.reservations r
  where r.reservation_id = p_reservation_id;
$$;

grant execute on function public.get_reservation_effective_total(uuid) to authenticated;

-- ============================================================
-- 3. reservation_payment_summary — reproduced verbatim from its current
--    source (20261020_additional_head_requests.sql) with reservation_total/
--    outstanding_balance/computed_status now computed against total_price
--    + non-voided charges instead of bare total_price. total_paid's own
--    exclusion list (cancellation_fee/reschedule_fee/extension_fee/
--    additional_head_fee) is untouched — a manual charge is paid down
--    through the ordinary base payment types, which were never excluded.
-- ============================================================
create or replace view public.reservation_payment_summary as
select
  r.reservation_id,
  -- Explicit numeric(10,2) cast: plain numeric arithmetic (a + b) drops the
  -- source columns' typmod, so without this cast reservation_total resolves
  -- to unconstrained numeric — which CREATE OR REPLACE VIEW refuses as a
  -- column type change from the existing numeric(10,2) (confirmed via the
  -- actual error this migration threw: "cannot change data type of view
  -- column reservation_total from numeric(10,2) to numeric").
  (r.total_price + coalesce(c.total_charged, 0))::numeric(10,2) as reservation_total,
  coalesce(p.total_paid, 0) as total_paid,
  greatest((r.total_price + coalesce(c.total_charged, 0))::numeric(10,2) - coalesce(p.total_paid, 0), 0) as outstanding_balance,
  p.latest_payment_date,
  case
    when coalesce(p.total_paid, 0) = 0 then 'unpaid'
    when coalesce(p.total_paid, 0) < (r.total_price + coalesce(c.total_charged, 0)) then 'partially_paid'
    when coalesce(p.total_paid, 0) = (r.total_price + coalesce(c.total_charged, 0)) then 'paid_in_full'
    else 'overpaid'
  end as computed_status
from public.reservations r
left join lateral (
  select
    sum(pay.amount) as total_paid,
    max(coalesce(pay.actual_payment_date, pay.payment_date, pay.cash_payment_date, pay.submitted_at::date)) as latest_payment_date
  from public.payment pay
  where pay.reservation_id = r.reservation_id
    and lower(pay.payment_status) = 'approved'
    and pay.payment_type not in ('cancellation_fee', 'reschedule_fee', 'extension_fee', 'additional_head_fee')
) p on true
left join lateral (
  select sum(rc.amount) as total_charged
  from public.reservation_charges rc
  where rc.reservation_id = r.reservation_id
    and rc.voided = false
) c on true;

grant select on public.reservation_payment_summary to authenticated;

alter view public.reservation_payment_summary set (security_invoker = true);

-- ============================================================
-- 4. validate_payment_submission() — reproduced verbatim from its current
--    source (20261020_additional_head_requests.sql) with exactly two
--    substitutions, both marked inline: the base-balance cancelled-status
--    branch's floor check and the partial_payment amount-bounds block now
--    compare against v_effective_total (total_price + non-voided charges)
--    instead of bare v_reservation.total_price. Every other branch
--    (extension_fee/additional_head_fee/reschedule_fee/cancellation_fee,
--    all flat fees validated against their own separate target) is
--    unchanged — those were never balance-relative to begin with.
-- ============================================================
create or replace function public.validate_payment_submission()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_reservation    public.reservations%rowtype;
  v_effective_total numeric;
  v_approved_total numeric;
  v_remaining      numeric;
  v_deposit_pct    numeric := 30;
  v_min_amount     numeric;
  v_rules          jsonb;
  v_payment_rules  jsonb;
  v_has_pending    boolean;
  v_extension      public.reservation_extensions%rowtype;
  v_additional_head public.reservation_additional_head_requests%rowtype;
  v_reschedule     public.reschedule_requests%rowtype;
  v_expected_fee   numeric;
begin
  if new.payment_source = 'in_cafe' then
    return new;
  end if;

  -- Staff-recorded/administered inserts skip the customer self-service
  -- eligibility checks below entirely — those exist to stop a CUSTOMER
  -- from submitting against a settled/pending/invalid/expired target, not
  -- to second-guess staff who already have their own RLS-gated,
  -- role-restricted policies on this table.
  if public.get_my_role() in ('manager', 'admin') then
    return new;
  end if;

  -- Ownership, server-side. A tampered reservation_id (someone else's
  -- reservation) fails right here, before any target-specific lookup runs
  -- — every target below is resolved by joining back to
  -- new.reservation_id, so ownership of the target follows from ownership
  -- of the reservation without a second auth.uid() check per type.
  select * into v_reservation
  from public.reservations r
  where r.reservation_id = new.reservation_id
    and r.user_id = auth.uid();

  if v_reservation.reservation_id is null then
    raise exception 'Reservation not found for this payment.';
  end if;

  -- Manual Charge for Special Requests (20261022) — the base balance a
  -- customer can pay toward now includes any non-voided manual charges.
  v_effective_total := public.get_reservation_effective_total(v_reservation.reservation_id);

  select setting_value::jsonb into v_payment_rules
  from public.system_settings
  where setting_key = 'payment_rules';

  if new.payment_type = 'extension_fee' then
    -- ── Target: reservation_extensions ────────────────────────────────
    if new.extension_id is null then
      raise exception 'An extension request must be specified for this payment.';
    end if;

    select * into v_extension
    from public.reservation_extensions e
    where e.extension_id = new.extension_id
      and e.reservation_id = new.reservation_id;

    if v_extension.extension_id is null then
      raise exception 'Extension request not found for this reservation.';
    end if;

    if v_extension.status = 'pending_verification' then
      raise exception 'A payment for this extension has already been submitted and is awaiting review.';
    elsif v_extension.status = 'approved' then
      raise exception 'This extension has already been paid and approved — no further payment is needed.';
    elsif v_extension.status = 'rejected' then
      raise exception 'This extension request was rejected. Please submit a new extension request.';
    elsif v_extension.status = 'expired' then
      raise exception 'This extension request has expired. Please submit a new extension request.';
    elsif v_extension.status <> 'pending_payment' then
      raise exception 'This extension request is no longer available for payment.';
    end if;

    if v_extension.hold_expires_at is not null and v_extension.hold_expires_at < now() then
      raise exception 'This extension request has expired. Please submit a new extension request.';
    end if;

    -- A reservation that's since moved into cancellation has no legitimate
    -- reason to pay for MORE time on it — cancellation doesn't currently
    -- auto-void an open extension the way it auto-voids an open reschedule
    -- (20260907_cancellation_supersedes_reschedule.sql), so this is the
    -- one place that has to be checked explicitly instead of inherited
    -- from the target's own status.
    if lower(coalesce(v_reservation.status, '')) in ('cancelled', 'declined', 'cancellation_requested', 'cancellation_approved') then
      raise exception 'This reservation is cancelled, or a cancellation is pending — the extension can no longer be paid for.';
    end if;

    if round(coalesce(new.amount, -1), 2) is distinct from round(v_extension.total_price, 2) then
      raise exception 'Payment amount must equal the extension fee of %.', v_extension.total_price;
    end if;

  elsif new.payment_type = 'additional_head_fee' then
    -- ── Target: reservation_additional_head_requests ──────────────────
    if new.additional_head_request_id is null then
      raise exception 'An additional guests request must be specified for this payment.';
    end if;

    select * into v_additional_head
    from public.reservation_additional_head_requests h
    where h.additional_head_request_id = new.additional_head_request_id
      and h.reservation_id = new.reservation_id;

    if v_additional_head.additional_head_request_id is null then
      raise exception 'Additional guests request not found for this reservation.';
    end if;

    if v_additional_head.status = 'pending_verification' then
      raise exception 'A payment for this request has already been submitted and is awaiting review.';
    elsif v_additional_head.status = 'approved' then
      raise exception 'This request has already been paid and approved — no further payment is needed.';
    elsif v_additional_head.status = 'rejected' then
      raise exception 'This additional guests request was rejected. Please submit a new request.';
    elsif v_additional_head.status = 'expired' then
      raise exception 'This additional guests request has expired. Please submit a new request.';
    elsif v_additional_head.status <> 'pending_payment' then
      raise exception 'This additional guests request is no longer available for payment.';
    end if;

    if v_additional_head.hold_expires_at is not null and v_additional_head.hold_expires_at < now() then
      raise exception 'This additional guests request has expired. Please submit a new request.';
    end if;

    if lower(coalesce(v_reservation.status, '')) in ('cancelled', 'declined', 'cancellation_requested', 'cancellation_approved') then
      raise exception 'This reservation is cancelled, or a cancellation is pending — additional guests can no longer be paid for.';
    end if;

    if round(coalesce(new.amount, -1), 2) is distinct from round(v_additional_head.total_price, 2) then
      raise exception 'Payment amount must equal the additional guests fee of %.', v_additional_head.total_price;
    end if;

  elsif new.payment_type = 'reschedule_fee' then
    -- ── Target: reschedule_requests ───────────────────────────────────
    if new.reschedule_request_id is null then
      raise exception 'A reschedule request must be specified for this payment.';
    end if;

    select * into v_reschedule
    from public.reschedule_requests rr
    where rr.reschedule_request_id = new.reschedule_request_id
      and rr.reservation_id = new.reservation_id;

    if v_reschedule.reschedule_request_id is null then
      raise exception 'Reschedule request not found for this reservation.';
    end if;

    if v_reschedule.status = 'completed' then
      raise exception 'This reschedule has already been paid and completed — no further payment is needed.';
    elsif v_reschedule.status = 'rejected' then
      raise exception 'This reschedule request was rejected.';
    elsif v_reschedule.status in ('voided', 'withdrawn', 'expired') then
      raise exception 'This reschedule request is no longer active. Please check your reservation for its current status.';
    elsif v_reschedule.status <> 'approved_pending_payment' then
      raise exception 'This reschedule request is not currently awaiting payment.';
    end if;

    if v_reschedule.hold_expires_at is not null and v_reschedule.hold_expires_at < now() then
      raise exception 'This reschedule request has expired. Please check your reservation for its current status.';
    end if;

    v_expected_fee := coalesce((v_payment_rules->>'reschedule_fee')::numeric, 3000);
    if round(coalesce(new.amount, -1), 2) is distinct from round(v_expected_fee, 2) then
      raise exception 'Payment amount must equal the reschedule fee of %.', v_expected_fee;
    end if;

  elsif new.payment_type = 'cancellation_fee' then
    -- ── Target: the reservation's own cancellation state ──────────────
    -- No separate id column (unlike extension/reschedule/additional-head)
    -- — a reservation can only have one live cancellation attempt at a
    -- time, so reservation_id + payment_type is already an unambiguous
    -- target, matching reservation_cancellations' own one-row-per-
    -- reservation (on conflict (reservation_id)) shape.
    if lower(coalesce(v_reservation.status, '')) not in ('cancellation_requested', 'cancellation_approved', 'cancelled') then
      raise exception 'This reservation has no cancellation in progress.';
    end if;

    if v_reservation.status = 'cancellation_requested'
       and v_reservation.cancellation_hold_expires_at is not null
       and v_reservation.cancellation_hold_expires_at < now() then
      raise exception 'This cancellation window has expired. Please check your reservation for its current status.';
    end if;

    v_expected_fee := coalesce(
      (v_payment_rules->>(case when lower(coalesce(v_reservation.location_type, '')) = 'offsite'
        then 'cancellation_fee_offsite' else 'cancellation_fee_onsite' end))::numeric,
      case when lower(coalesce(v_reservation.location_type, '')) = 'offsite' then 2000 else 500 end
    );
    if round(coalesce(new.amount, -1), 2) is distinct from round(v_expected_fee, 2) then
      raise exception 'Payment amount must equal the cancellation fee of %.', v_expected_fee;
    end if;

  else
    -- ── Target: the reservation's own base balance ────────────────────
    -- reservation_fee / down_payment / full_payment / partial_payment.
    if lower(coalesce(v_reservation.status, '')) in ('cancelled', 'declined', 'cancellation_requested', 'cancellation_approved') then
      raise exception 'This reservation is cancelled, or a cancellation is pending — no further payment can be submitted.';
    end if;
  end if;

  -- ── Duplicate-pending guard ──────────────────────────────────────────
  -- Scoped to the specific target: reschedule_request_id for reschedule_fee,
  -- extension_id for extension_fee, additional_head_request_id for
  -- additional_head_fee (a reservation can cycle through more than one of
  -- any of these over its life, each with its own fee — a pending payment
  -- on a PAST one must never block a fresh one on a NEW request), and to
  -- the reservation for every other type (cancellation_fee and the four
  -- base types only ever have one live target at a time).
  select exists (
    select 1 from public.payment p
    where p.reservation_id = new.reservation_id
      and p.payment_type = new.payment_type
      and lower(coalesce(p.payment_status, '')) = 'pending_review'
      and (
        (new.payment_type = 'reschedule_fee' and p.reschedule_request_id is not distinct from new.reschedule_request_id)
        or (new.payment_type = 'extension_fee' and p.extension_id is not distinct from new.extension_id)
        or (new.payment_type = 'additional_head_fee' and p.additional_head_request_id is not distinct from new.additional_head_request_id)
        or (new.payment_type not in ('reschedule_fee', 'extension_fee', 'additional_head_fee'))
      )
  ) into v_has_pending;

  if v_has_pending then
    raise exception 'A payment of this type has already been submitted and is awaiting review.';
  end if;

  -- ── Remaining-balance guard — base payment types only ───────────────
  -- reschedule_fee/cancellation_fee/extension_fee/additional_head_fee are
  -- flat fees unrelated to the base package balance, already amount-checked
  -- against their own target above. Manual charges (20261022) inflate
  -- v_effective_total, computed once above, so this automatically stays
  -- correct without a separate branch.
  if new.payment_type in ('reservation_fee', 'down_payment', 'full_payment', 'partial_payment') then
    select coalesce(sum(p.amount), 0) into v_approved_total
    from public.payment p
    where p.reservation_id = new.reservation_id
      and p.payment_type in ('reservation_fee', 'down_payment', 'full_payment', 'partial_payment')
      and lower(p.payment_status) = 'approved';

    if greatest(v_effective_total - v_approved_total, 0) <= 0 then
      raise exception 'This reservation is already paid in full — no further payment is needed.';
    end if;
  end if;

  -- Reference-number format (unchanged from 20260901_bank_transfer_
  -- generic_reference.sql).
  if new.reference_number is not null and new.payment_method in ('gcash', 'maya', 'bpi', 'bank') then
    if new.payment_method = 'gcash' and new.reference_number !~ '^[0-9]{13}$' then
      raise exception 'GCash reference number must be exactly 13 digits.';
    elsif new.payment_method = 'maya' and new.reference_number !~ '^[0-9]{12,13}$' then
      raise exception 'Maya reference number must be 12 to 13 digits.';
    elsif new.payment_method in ('bpi', 'bank') and new.reference_number !~ '^[A-Za-z0-9-]{6,30}$' then
      raise exception 'Bank transfer reference number must be 6 to 30 letters, numbers, or hyphens.';
    end if;
  end if;

  -- partial_payment amount bounds — SUBSTITUTED: v_reservation.total_price
  -- replaced with v_effective_total (Manual Charge for Special Requests,
  -- 20261022), otherwise unchanged logic.
  if new.payment_type = 'partial_payment' then
    select coalesce(sum(p.amount), 0) into v_approved_total
    from public.payment p
    where p.reservation_id = new.reservation_id
      and p.reschedule_request_id is null
      and lower(p.payment_status) = 'approved';

    v_remaining := greatest(v_effective_total - v_approved_total, 0);

    select setting_value::jsonb into v_rules
    from public.system_settings
    where setting_key = 'reservation_rules';

    if v_rules is not null and v_rules ? 'deposit_pct' then
      v_deposit_pct := (v_rules->>'deposit_pct')::numeric;
    end if;

    v_min_amount := round(least(v_effective_total * v_deposit_pct / 100, v_remaining), 2);

    if new.amount is null or new.amount <= 0 then
      raise exception 'Custom payment amount must be greater than zero.';
    end if;
    if new.amount < v_min_amount then
      raise exception 'Custom payment amount must be at least %.', v_min_amount;
    end if;
    if new.amount > v_remaining then
      raise exception 'Custom payment amount cannot exceed the remaining balance of %.', v_remaining;
    end if;
  end if;

  return new;
end;
$$;

-- trg_validate_payment_submission (before insert on public.payment,
-- 20260716_payment_overhaul.sql) already points at this function by name
-- — no trigger changes needed, create or replace above is sufficient.

-- ============================================================
-- 5. void_reservation_charge() — manager/admin only. A charge is never
--    hard-deleted (per spec) and there is no UPDATE policy on the table
--    (section 1) — this SECURITY DEFINER function is the only path that
--    can flip voided=true, so it's also the one enforceable choke point
--    for "only while it hasn't been paid against."
--
--    This ledger has no per-line earmarking of which payment paid for
--    which charge (payments settle the reservation's AGGREGATE balance,
--    not individual lines) — so "paid against" is defined the only way
--    that's actually checkable without inventing a payment-allocation
--    system: voiding is blocked whenever approved payments already reach
--    far enough into the balance that removing this charge's amount would
--    make total_paid EXCEED the new, lower total (i.e., the remaining
--    balance right now, before voiding, must already be at least this
--    charge's amount — proof nothing has been collected against it yet).
--    If that guard trips, the charge is presumed already paid down and
--    must be handled as an adjustment instead (a new, separate manual
--    charge with a negative... no — amount must stay > 0 per the CHECK
--    constraint, so an adjustment in practice means: leave the original
--    charge voided-ineligible and have the manager/admin resolve it
--    directly with the customer, same as any other already-paid
--    correction in this system today; this function's job is only to
--    stop that state from being silently reachable through a plain void).
-- ============================================================
create or replace function public.void_reservation_charge(p_charge_id uuid, p_reason text default null)
returns public.reservation_charges
language plpgsql
security definer
set search_path = public
as $$
declare
  v_charge          public.reservation_charges%rowtype;
  v_effective_total numeric;
  v_approved_total  numeric;
  v_remaining       numeric;
begin
  if public.get_my_role() not in ('manager', 'admin') then
    raise exception using errcode = 'P0001', message = 'Not authorized.';
  end if;

  select * into v_charge
  from public.reservation_charges
  where charge_id = p_charge_id;

  if v_charge.charge_id is null then
    raise exception using errcode = 'P0001', message = 'Charge not found.';
  end if;

  if v_charge.voided then
    raise exception using errcode = 'P0001', message = 'This charge has already been voided.';
  end if;

  v_effective_total := public.get_reservation_effective_total(v_charge.reservation_id);

  select coalesce(sum(p.amount), 0) into v_approved_total
  from public.payment p
  where p.reservation_id = v_charge.reservation_id
    and p.payment_type in ('reservation_fee', 'down_payment', 'full_payment', 'partial_payment')
    and lower(p.payment_status) = 'approved';

  v_remaining := greatest(v_effective_total - v_approved_total, 0);

  if v_remaining < v_charge.amount then
    raise exception using
      errcode = 'P0001',
      message = 'This charge has already been paid against and cannot be voided directly — settle it as an adjustment with the customer instead.';
  end if;

  update public.reservation_charges
  set voided = true,
      voided_by = auth.uid(),
      voided_at = now(),
      void_reason = p_reason
  where charge_id = p_charge_id
  returning * into v_charge;

  return v_charge;
end;
$$;

grant execute on function public.void_reservation_charge(uuid, text) to authenticated;
