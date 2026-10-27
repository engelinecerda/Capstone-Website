-- Fix: the hourly auto_cancel_overdue_reservations() cron job failed on every
-- run with "Reservation not found for this payment." once a reservation
-- actually reached the cancel-and-charge step, so overdue reservations were
-- never cancelled and no cancellation fee was created.
--
-- Cause: the job inserts a cancellation_fee row into public.payment, which
-- fires validate_payment_submission(). That trigger requires the inserter to
-- be the reservation's owner (r.user_id = auth.uid()) or a manager/admin.
-- A pg_cron run is neither (auth.uid() is null), so the ownership lookup
-- found nothing and raised, rolling back the entire run — repeating hourly.
-- It stayed hidden until the first reservations became overdue.
--
-- Fix (two parts, both reproduced verbatim from their current source with
-- only the marked additions):
--   1. auto_cancel_overdue_reservations() (source: 20260818_flagged_fixes.sql)
--      sets a transaction-local marker, app.system_job, while it runs.
--   2. validate_payment_submission() (source: 20261022_manual_reservation_
--      charges.sql) lets a cancellation_fee insert through ONLY when there
--      is no authenticated user AND that marker is present. All customer
--      validation is unchanged and still fully enforced for every real user.
--
-- No trigger or cron schedule changes: trg_validate_payment_submission
-- already points at the function by name, and the existing
-- 'auto-cancel-overdue-reservations' schedule keeps calling the function.

-- ============================================================
-- 1. validate_payment_submission() — adds the system-job bypass.
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

  -- System-job bypass (20261104) — auto_cancel_overdue_reservations() runs
  -- from pg_cron with no logged-in user, so every ownership/role check
  -- below would reject its cancellation_fee insert ("Reservation not found
  -- for this payment."), rolling back the whole run every hour. Three
  -- conditions must ALL hold, so this can never be reached by a customer:
  --   1. the row is a cancellation_fee (the only thing the job inserts);
  --   2. there is no authenticated user (auth.uid() is null) — any real
  --      customer/staff session has one;
  --   3. the job set its own transaction-local marker (set_config(..., true)
  --      in the job function), which a client request cannot set.
  if new.payment_type = 'cancellation_fee'
     and auth.uid() is null
     and current_setting('app.system_job', true) = 'auto_cancel_overdue_reservations' then
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
-- 2. auto_cancel_overdue_reservations() — sets the system-job marker.
-- ============================================================
create or replace function public.auto_cancel_overdue_reservations()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_auto_cancel_days integer := 5;
  v_rules jsonb;
  v_payment_rules jsonb;
  v_cancel_fee_onsite numeric := 500;
  v_cancel_fee_offsite numeric := 2000;
  v_res record;
  v_cancellation_fee numeric;
  v_due_date date;
  v_grace_deadline timestamptz;
begin
  -- Marks this transaction as the auto-cancel job so
  -- validate_payment_submission() (20261104) lets its system-generated
  -- cancellation_fee insert through. Transaction-local (is_local = true):
  -- it resets on its own at commit/rollback and never leaks to other sessions.
  perform set_config('app.system_job', 'auto_cancel_overdue_reservations', true);

  select setting_value::jsonb into v_rules
  from public.system_settings
  where setting_key = 'reservation_rules';

  if v_rules is not null and v_rules ? 'auto_cancel_days' then
    v_auto_cancel_days := (v_rules->>'auto_cancel_days')::integer;
  end if;

  select setting_value::jsonb into v_payment_rules
  from public.system_settings
  where setting_key = 'payment_rules';

  if v_payment_rules is not null and v_payment_rules ? 'cancellation_fee_onsite' then
    v_cancel_fee_onsite := (v_payment_rules->>'cancellation_fee_onsite')::numeric;
  end if;
  if v_payment_rules is not null and v_payment_rules ? 'cancellation_fee_offsite' then
    v_cancel_fee_offsite := (v_payment_rules->>'cancellation_fee_offsite')::numeric;
  end if;

  for v_res in
    select
      r.reservation_id, r.user_id, r.status, r.location_type, r.event_date, r.total_price,
      coalesce(sum(p.amount) filter (
        where lower(p.payment_status) = 'approved' and p.reschedule_request_id is null
      ), 0) as approved_total,
      bool_or(
        lower(p.payment_status) = 'pending_review' and p.reschedule_request_id is null
      ) as has_pending_payment
    from public.reservations r
    left join public.payment p on p.reservation_id = r.reservation_id
    where lower(r.status) in ('approved', 'confirmed', 'rescheduled')
    group by r.reservation_id, r.user_id, r.status, r.location_type, r.event_date, r.total_price
  loop
    if v_res.approved_total >= v_res.total_price then
      continue;
    end if;
    if v_res.has_pending_payment then
      continue;
    end if;

    v_due_date := v_res.event_date - public.get_full_payment_days();
    v_grace_deadline := v_due_date::timestamptz + (v_auto_cancel_days || ' days')::interval;
    if v_grace_deadline > now() then
      continue;
    end if;

    v_cancellation_fee := case when lower(v_res.location_type) = 'offsite' then v_cancel_fee_offsite else v_cancel_fee_onsite end;

    update public.reservations
    set status = 'cancelled', cancellation_reason = 'auto_cancelled_overdue'
    where reservation_id = v_res.reservation_id;

    insert into public.reservation_cancellations (reservation_id, user_id, previous_status, reason, cancelled_at)
    values (
      v_res.reservation_id, v_res.user_id, v_res.status,
      'Automatically cancelled: payment was not received within the grace period.',
      now()
    )
    on conflict (reservation_id) do update
      set previous_status = excluded.previous_status,
          reason = excluded.reason,
          cancelled_at = excluded.cancelled_at;

    insert into public.payment (reservation_id, payment_type, amount, payment_status, submitted_at)
    values (v_res.reservation_id, 'cancellation_fee', v_cancellation_fee, 'pending_review', now());

    insert into public.reservation_status (reservation_id, previous_status, new_status, changed_at)
    values (v_res.reservation_id, v_res.status, 'cancelled', now());
  end loop;

  perform set_config('app.system_job', '', true);
end;
$$;

grant execute on function public.auto_cancel_overdue_reservations() to service_role;
