-- Server-side payment-purpose validation — the safety layer described in
-- the "Always allow customers to view/pay" spec's follow-up: every payment
-- attempt must carry an explicit, single target (reservation | extension |
-- reschedule | cancellation), and the server must independently confirm
-- that target still legitimately owes money, for exactly the right amount,
-- before accepting the submission — not just trust whatever the browser's
-- in-memory bundle last computed.
--
-- validate_payment_submission() (20260716_payment_overhaul.sql, most
-- recently redefined 20260912_payment_page_server_guard.sql) is the one
-- real BEFORE INSERT gate on public.payment — this table is written to
-- directly from the browser with no API layer in front of it. It already
-- validates reservation_fee/down_payment/full_payment/partial_payment
-- correctly (ownership, cancelled-status guard, remaining-balance guard,
-- duplicate-pending guard, deposit-pct bounds) and cancellation_fee's
-- status guard. What it never gained, across the reschedule-hold,
-- cancellation-debt, and extension-hours features layered on afterward:
--
--   1. extension_fee had NO validation at all — no ownership check on
--      extension_id, no check that the extension is still pending_payment,
--      no amount check against reservation_extensions.total_price. A
--      customer could submit any amount against any extension_id (their
--      own or, since nothing checked it belonged to new.reservation_id,
--      potentially a stale one) and the row would be silently accepted —
--      link_extension_payment_submission() (AFTER INSERT) only links it
--      into reservation_extensions if the state happens to be right, and
--      says nothing if it isn't, leaving an orphaned, unreviewable payment
--      row and a customer who thinks they paid.
--   2. reschedule_fee had a duplicate-pending guard but never checked the
--      reschedule_requests row's own status (approved_pending_payment vs.
--      completed/rejected/voided/withdrawn/expired) or its hold_expires_at
--      — a stale/superseded/expired reschedule could still be paid for.
--   3. Neither reschedule_fee nor cancellation_fee validated the submitted
--      amount against the actual configured fee (payment_rules.
--      reschedule_fee / cancellation_fee_onsite / cancellation_fee_offsite)
--      at all — only partial_payment had amount bounds.
--   4. The duplicate-pending guard's extension_fee case was unscoped (any
--      pending extension_fee row blocked ALL extension_fee submissions,
--      not just ones against the same extension_id) — reschedule_fee
--      already got this right via reschedule_request_id scoping; this
--      brings extension_fee to the same standard.
--
-- All four target types now follow the same shape: resolve the specific
-- target record (ownership implied by it belonging to new.reservation_id,
-- which is already checked against auth.uid() above), confirm it's in the
-- one state that legitimately owes payment, confirm it hasn't expired, and
-- confirm the amount matches exactly what that target actually costs.
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
  v_payment_rules  jsonb;
  v_has_pending    boolean;
  v_extension      public.reservation_extensions%rowtype;
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
    -- No separate id column (unlike extension/reschedule) — a reservation
    -- can only have one live cancellation attempt at a time, so
    -- reservation_id + payment_type is already an unambiguous target,
    -- matching reservation_cancellations' own one-row-per-reservation
    -- (on conflict (reservation_id)) shape.
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
  -- Scoped to the specific target: reschedule_request_id for reschedule_fee
  -- and extension_id for extension_fee (a reservation can cycle through
  -- more than one of either over its life, each with its own fee — a
  -- pending payment on a PAST one must never block a fresh one on a NEW
  -- request), and to the reservation for every other type (cancellation_fee
  -- and the four base types only ever have one live target at a time).
  select exists (
    select 1 from public.payment p
    where p.reservation_id = new.reservation_id
      and p.payment_type = new.payment_type
      and lower(coalesce(p.payment_status, '')) = 'pending_review'
      and (
        (new.payment_type = 'reschedule_fee' and p.reschedule_request_id is not distinct from new.reschedule_request_id)
        or (new.payment_type = 'extension_fee' and p.extension_id is not distinct from new.extension_id)
        or (new.payment_type not in ('reschedule_fee', 'extension_fee'))
      )
  ) into v_has_pending;

  if v_has_pending then
    raise exception 'A payment of this type has already been submitted and is awaiting review.';
  end if;

  -- ── Remaining-balance guard — base payment types only ───────────────
  -- reschedule_fee/cancellation_fee/extension_fee are flat fees unrelated
  -- to the base package balance, already amount-checked against their own
  -- target above.
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

  -- partial_payment amount bounds (unchanged logic).
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
