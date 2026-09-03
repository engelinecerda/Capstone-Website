-- Always-Viewable Customer Payment Page — the page itself already renders
-- for the owner in every state (js/payment.js's renderReservationPaymentPage
-- routes to renderCompleteCard/renderPendingCard/renderCancellationCard/
-- renderActionableCard, always alongside the persistent History/Receipts
-- tabs — verified: it never blanks or redirects for a legitimately-owned
-- reservation, only for a foreign/missing one), and viewing is already
-- correctly RLS-scoped (public.payment's "customer read own payments" and
-- public.reservations' "select own reservations" both key off
-- auth.uid() = the reservation's owner — a customer cannot open another
-- customer's payment records by editing the reservation_id in the URL).
--
-- What was missing: hiding the submit form when a balance is settled, a
-- payment is pending, or the reservation is cancelled is UX only
-- (js/customer_payments.js's getAvailablePaymentOptions, evaluated
-- against the browser's in-memory bundle — not re-fetched immediately
-- before submission, and trivially bypassable via a direct insert).
-- validate_payment_submission() (the one real server-side gate on
-- public.payment inserts, since this table is written to directly from
-- the browser with no API layer in between) only ever bounded
-- partial_payment's amount — reservation_fee/down_payment/full_payment/
-- reschedule_fee/cancellation_fee had no server-side balance, duplicate-
-- pending, or cancelled-status check at all. This closes that gap.

create or replace function public.validate_payment_submission()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_reservation    public.reservations%rowtype;
  v_approved_total numeric;
  v_remaining      numeric;
  v_deposit_pct    numeric := 30;
  v_min_amount     numeric;
  v_rules          jsonb;
  v_has_pending    boolean;
begin
  if new.payment_source = 'in_cafe' then
    return new;
  end if;

  -- Staff-recorded/administered inserts (a manager inserting a
  -- cancellation_fee row under the pre-update-v20 flow, or any other
  -- manager/admin-initiated write to this table) skip the customer
  -- self-service eligibility checks below entirely — those exist to stop
  -- a CUSTOMER from submitting against a settled, pending, or cancelled
  -- reservation, not to second-guess staff who already have their own
  -- RLS-gated, role-restricted policies on this table.
  if public.get_my_role() in ('manager', 'admin') then
    return new;
  end if;

  -- Ownership + eligibility, server-side. RLS on public.payment already
  -- scopes SELECT to the reservation's owner, and there's a customer
  -- INSERT policy for base payment types already live on this table (not
  -- tracked in migrations prior to this file — see the note below), but a
  -- PERMISSIVE RLS policy can only ever ADD permission, never narrow one
  -- an unrelated policy already grants, so it cannot be relied on alone to
  -- enforce "and the reservation isn't settled/pending/cancelled." This
  -- trigger is the one place that check can be made unconditional.
  select * into v_reservation
  from public.reservations r
  where r.reservation_id = new.reservation_id
    and r.user_id = auth.uid();

  if v_reservation.reservation_id is null then
    raise exception 'Reservation not found for this payment.';
  end if;

  if new.payment_type = 'cancellation_fee' then
    -- The one case where "cancelled" is exactly the valid state — a
    -- cancellation_fee only makes sense once a cancellation is actually
    -- in progress or finalized. 'cancellation_approved' is the pre-
    -- update-v20 status, kept for any reservation still sitting in it.
    if lower(coalesce(v_reservation.status, '')) not in ('cancellation_requested', 'cancellation_approved', 'cancelled') then
      raise exception 'This reservation has no cancellation in progress.';
    end if;
  else
    if lower(coalesce(v_reservation.status, '')) in ('cancelled', 'declined', 'cancellation_requested', 'cancellation_approved') then
      raise exception 'This reservation is cancelled, or a cancellation is pending — no further payment can be submitted.';
    end if;
  end if;

  -- Duplicate-pending guard — the single most easily missed check per the
  -- Always-Viewable Payment Page spec: a customer must not be able to pay
  -- twice for the same thing while the first submission still awaits
  -- review. Scoped to the specific reschedule_request_id for
  -- reschedule_fee (a reservation can cycle through more than one
  -- reschedule request over its life, each with its own fee), and to the
  -- reservation for every other type.
  select exists (
    select 1 from public.payment p
    where p.reservation_id = new.reservation_id
      and p.payment_type = new.payment_type
      and lower(coalesce(p.payment_status, '')) = 'pending_review'
      and (
        new.payment_type is distinct from 'reschedule_fee'
        or p.reschedule_request_id is not distinct from new.reschedule_request_id
      )
  ) into v_has_pending;

  if v_has_pending then
    raise exception 'A payment of this type has already been submitted and is awaiting review.';
  end if;

  -- Remaining-balance guard — base payment types only. reschedule_fee/
  -- cancellation_fee are flat fees unrelated to the base package balance.
  if new.payment_type in ('reservation_fee', 'down_payment', 'full_payment', 'partial_payment') then
    select coalesce(sum(p.amount), 0) into v_approved_total
    from public.payment p
    where p.reservation_id = new.reservation_id
      and p.payment_type in ('reservation_fee', 'down_payment', 'full_payment', 'partial_payment')
      and lower(p.payment_status) = 'approved';

    if greatest(coalesce(v_reservation.total_price, 0) - v_approved_total, 0) <= 0 then
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

  -- partial_payment amount bounds (unchanged logic, now reusing
  -- v_reservation instead of a second query for total_price).
  if new.payment_type = 'partial_payment' then
    select coalesce(sum(p.amount), 0) into v_approved_total
    from public.payment p
    where p.reservation_id = new.reservation_id
      and p.reschedule_request_id is null
      and lower(p.payment_status) = 'approved';

    v_remaining := greatest(coalesce(v_reservation.total_price, 0) - v_approved_total, 0);

    select setting_value::jsonb into v_rules
    from public.system_settings
    where setting_key = 'reservation_rules';

    if v_rules is not null and v_rules ? 'deposit_pct' then
      v_deposit_pct := (v_rules->>'deposit_pct')::numeric;
    end if;

    v_min_amount := round(least(coalesce(v_reservation.total_price, 0) * v_deposit_pct / 100, v_remaining), 2);

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

-- Formalizes the customer base-payment INSERT policy under version
-- control. public.payment has a live customer INSERT policy that was
-- never checked into migrations (see 20260713_fix_payment_rls.sql's own
-- note on this) — its exact WITH CHECK clause can't be audited from this
-- repo, and since it's unknown, it can't safely be dropped/replaced by
-- name here. This is added ADDITIVELY (a distinct policy name) so it
-- coexists with whatever already exists; Postgres OR's multiple
-- permissive policies together for the same command, so this can only
-- ever grant what the trigger above still independently gates — it is
-- not a substitute for that trigger, just documentation-as-code for the
-- ownership half of the rule.
drop policy if exists "customer insert own base payment" on public.payment;
create policy "customer insert own base payment"
  on public.payment for insert
  with check (
    payment_type in ('reservation_fee', 'down_payment', 'full_payment', 'partial_payment', 'reschedule_fee')
    and payment_status = 'pending_review'
    and exists (
      select 1 from public.reservations r
      where r.reservation_id = payment.reservation_id
        and r.user_id = auth.uid()
    )
  );
