-- Notice-based cancellation and reschedule fees (percent of the total
-- contract amount), replacing the flat amounts for customer-requested
-- cancellations and reschedules.
--
-- Policy (Terms, section 6; confirmed with the owner)
--   * All payments are non-refundable (unchanged).
--   * Cancelling LESS than 2 days before the event: fee = 30% of the total
--     contract amount (the full 30%, on top of what was already paid, which
--     the cafe keeps). Cancelling 2 or more days before: no fee.
--     Nothing paid at all: no fee (20261201 rule, kept).
--   * Rescheduling LESS than 30 days before the ORIGINAL event date: fee =
--     10% of the total contract amount. 30 or more days: no fee.
--   * "Total contract amount" = reservations.total_price (package, add-ons,
--     extra guests, transport fee, service charge, less discount).
--   * Days are whole calendar days in Asia/Manila (event date minus today).
--
-- Everything is configurable in system_settings.payment_rules, with the
-- policy above as the default when a key was never saved:
--   cancellation_fee_notice_days (2)   cancellation_fee_percent (30)
--   reschedule_fee_notice_days  (30)   reschedule_fee_percent   (10)
-- The old flat cancellation_fee_onsite/offsite remain ONLY for the overdue
-- auto-cancel job (not a customer request, so the notice rule does not
-- apply to it) and for requests already in flight. reschedule_fee (flat) is
-- kept only for those in-flight requests.
--
-- How it works
--   * cancellation_fee_for() / reschedule_fee_for() are the one place the
--     amount is decided. js/reservation_shared.js mirrors them for display
--     (a test keeps the two identical).
--   * The amount is FROZEN when the request is made (reservations.
--     cancellation_fee_amount, reschedule_requests.fee_amount), so a later
--     settings change never reprices a request already made. Only the
--     database sets these columns; a customer cannot write them.
--   * validate_payment_submission() now expects exactly that frozen amount.
--   * A request whose fee is 0 needs no payment, so it completes on its own:
--     a cancellation becomes 'cancelled' at once, a reschedule moves the
--     date at once. Both tell the customer and the managers.
--   * is_cancellation_fee_waived() also covers a free customer
--     cancellation, so it never counts as unpaid cancellation debt.
--
-- Deploy order: run this file FIRST (the new site code reads the two new
-- columns), then push the website and deploy generate-signed-contract.
-- Existing reservations, requests and fees are not touched.

alter table public.reservations
  add column if not exists cancellation_fee_amount numeric(12,2);
alter table public.reschedule_requests
  add column if not exists fee_amount numeric(12,2);

alter table public.reservations
  drop constraint if exists reservations_cancellation_fee_amount_check;
alter table public.reservations
  add constraint reservations_cancellation_fee_amount_check
  check (cancellation_fee_amount is null or cancellation_fee_amount >= 0);
alter table public.reschedule_requests
  drop constraint if exists reschedule_requests_fee_amount_check;
alter table public.reschedule_requests
  add constraint reschedule_requests_fee_amount_check
  check (fee_amount is null or fee_amount >= 0);

comment on column public.reservations.cancellation_fee_amount is
  'Cancellation fee (PHP) frozen when the customer asked to cancel. 0 = no fee (cancelled at once). NULL = not set by the notice rule (overdue auto-cancel, or requested before 20261206): the flat fee applies.';
comment on column public.reschedule_requests.fee_amount is
  'Reschedule fee (PHP) frozen when the request was made. 0 = no fee (moved at once). NULL = requested before 20261206: the flat reschedule_fee applies.';

-- ── 1. The rule, in one place ───────────────────────────────────────────────
create or replace function public.policy_today()
returns date
language sql
stable
as $$
  select (now() at time zone 'Asia/Manila')::date
$$;

grant execute on function public.policy_today() to authenticated, service_role;

create or replace function public.cancellation_fee_for(p_reservation_id uuid)
returns numeric
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_res    record;
  v_rules  jsonb;
  v_notice numeric;
  v_pct    numeric;
  v_paid   numeric;
begin
  select r.event_date, r.total_price into v_res
  from public.reservations r
  where r.reservation_id = p_reservation_id;

  if not found or v_res.event_date is null then
    return 0;
  end if;

  select ss.setting_value::jsonb into v_rules
  from public.system_settings ss
  where ss.setting_key = 'payment_rules';

  v_notice := coalesce((v_rules->>'cancellation_fee_notice_days')::numeric, 2);
  v_pct    := coalesce((v_rules->>'cancellation_fee_percent')::numeric, 30);

  -- Enough notice: no fee.
  if (v_res.event_date - public.policy_today()) >= v_notice then
    return 0;
  end if;

  -- Nothing paid at all: nothing to charge a fee against (20261201).
  select coalesce(sum(p.amount), 0) into v_paid
  from public.payment p
  where p.reservation_id = p_reservation_id
    and lower(coalesce(p.payment_status, '')) = 'approved';
  if v_paid <= 0 then
    return 0;
  end if;

  return round(coalesce(v_res.total_price, 0) * v_pct / 100, 2);
end;
$$;

create or replace function public.reschedule_fee_for(p_reservation_id uuid)
returns numeric
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_res    record;
  v_rules  jsonb;
  v_notice numeric;
  v_pct    numeric;
begin
  select r.event_date, r.total_price into v_res
  from public.reservations r
  where r.reservation_id = p_reservation_id;

  if not found or v_res.event_date is null then
    return 0;
  end if;

  select ss.setting_value::jsonb into v_rules
  from public.system_settings ss
  where ss.setting_key = 'payment_rules';

  v_notice := coalesce((v_rules->>'reschedule_fee_notice_days')::numeric, 30);
  v_pct    := coalesce((v_rules->>'reschedule_fee_percent')::numeric, 10);

  -- Counted from the ORIGINAL event date (the one still on the reservation).
  if (v_res.event_date - public.policy_today()) >= v_notice then
    return 0;
  end if;

  return round(coalesce(v_res.total_price, 0) * v_pct / 100, 2);
end;
$$;

revoke all on function public.cancellation_fee_for(uuid) from public, anon;
revoke all on function public.reschedule_fee_for(uuid) from public, anon;
grant execute on function public.cancellation_fee_for(uuid) to authenticated, service_role;
grant execute on function public.reschedule_fee_for(uuid) to authenticated, service_role;

-- ── 2. Cancellation: freeze the fee when the hold starts ────────────────────
-- Reproduced from 20260909_reschedule_hold_and_cancellation_debt.sql; the
-- additions are marked 20261206.
create or replace function public.set_cancellation_hold_expiry()
returns trigger
language plpgsql
as $$
declare
  v_rules_json jsonb;
  v_hold_hours numeric := 48;
begin
  -- 20261206: only the database decides the frozen fee. Staff and system
  -- jobs may change it; a customer's own update never can.
  if new.cancellation_fee_amount is distinct from old.cancellation_fee_amount
     and coalesce(public.get_my_role(), '') not in ('manager', 'admin')
     and auth.uid() is not null then
    new.cancellation_fee_amount := old.cancellation_fee_amount;
  end if;

  -- 20261206: a withdrawn request leaves nothing frozen behind.
  if old.status = 'cancellation_requested'
     and lower(coalesce(new.status, '')) not in ('cancellation_requested', 'cancelled', 'cancellation_approved') then
    new.cancellation_fee_amount := null;
  end if;

  if new.status is distinct from 'cancellation_requested' or old.status = 'cancellation_requested' then
    return new;
  end if;

  if lower(coalesce(old.status, '')) not in ('approved', 'confirmed', 'rescheduled') then
    raise exception using
      errcode = 'P0001',
      message = 'This reservation is no longer eligible for cancellation.';
  end if;

  select ss.setting_value::jsonb into v_rules_json
  from public.system_settings ss
  where ss.setting_key = 'payment_rules';
  v_hold_hours := coalesce((v_rules_json->>'cancellation_hold_hours')::numeric, 48);

  new.pre_cancellation_status := old.status;
  -- 20261206: freeze what this cancellation costs, from today's notice.
  new.cancellation_fee_amount := public.cancellation_fee_for(new.reservation_id);
  new.cancellation_hold_expires_at := now() + make_interval(secs => v_hold_hours * 3600);
  return new;
end;
$$;

-- A cancellation that costs nothing completes at once: there is no fee to
-- wait for, so the hold would only keep the date blocked for nothing.
create or replace function public.finalize_free_cancellation()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_number text;
  v_name   text;
begin
  if new.status is distinct from 'cancellation_requested'
     or old.status = 'cancellation_requested'
     or new.cancellation_fee_amount is null
     or new.cancellation_fee_amount > 0 then
    return new;
  end if;

  update public.reservations
  set status = 'cancelled',
      cancellation_hold_expires_at = null
  where reservation_id = new.reservation_id;

  insert into public.reservation_status (reservation_id, previous_status, new_status, changed_at)
  values (new.reservation_id, coalesce(new.pre_cancellation_status, old.status), 'cancelled', now());

  insert into public.reservation_cancellations (reservation_id, user_id, previous_status, reason, cancelled_at)
  values (
    new.reservation_id,
    new.user_id,
    coalesce(new.pre_cancellation_status, old.status, 'approved'),
    coalesce(new.cancellation_reason, 'Cancelled by customer'),
    now()
  )
  on conflict (reservation_id) do nothing;

  v_number := new.reservation_number::text;
  v_name   := coalesce(new.contact_name, 'A customer');

  if new.user_id is not null then
    insert into public.notifications (user_id, type, title, body, link)
    values (
      new.user_id,
      'reservation_status',
      'Reservation Cancelled',
      'Your reservation' || coalesce(' ' || v_number, '') || ' for '
        || to_char(new.event_date::timestamp, 'FMMonth DD, YYYY')
        || ' has been cancelled. No cancellation fee applies. Payments already made are non-refundable.',
      '/account.html'
    );
  end if;

  insert into public.notifications (user_id, type, title, body, link)
  select p.user_id,
         'reservation_status',
         'Reservation Cancelled',
         v_name || ' cancelled reservation' || coalesce(' ' || v_number, '') || ' (no cancellation fee).',
         '/admin/reservation-details.html?id=' || new.reservation_id::text
  from public.profiles p
  where p.role = 'manager';

  return new;
end;
$$;

drop trigger if exists trg_finalize_free_cancellation on public.reservations;
create trigger trg_finalize_free_cancellation
after update on public.reservations
for each row execute function public.finalize_free_cancellation();

-- ── 3. Cancellation debt: a free cancellation owes nothing ──────────────────
-- 20261202's rule, widened: cancelled + NO cancellation_fee row, and either
-- the overdue auto-cancel (nothing paid) or a customer cancellation whose
-- frozen fee is 0. It only holds while no fee row exists.
create or replace function public.is_cancellation_fee_waived(p_reservation_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.reservations r
    where r.reservation_id = p_reservation_id
      and lower(r.status) = 'cancelled'
      and (
        r.cancellation_reason = 'auto_cancelled_overdue'
        or r.cancellation_fee_amount = 0   -- 20261206
      )
  )
  and not exists (
    select 1 from public.payment p
    where p.reservation_id = p_reservation_id
      and p.payment_type = 'cancellation_fee'
  );
$$;

-- ── 4. Reschedule: freeze the fee on the request ────────────────────────────
-- A customer's own value is always replaced; staff and system inserts (for
-- example a backup restore) keep whatever they carry.
create or replace function public.set_reschedule_request_fee()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null or coalesce(public.get_my_role(), '') in ('manager', 'admin') then
    return new;
  end if;
  new.fee_amount := public.reschedule_fee_for(new.reservation_id);
  return new;
end;
$$;

drop trigger if exists trg_set_reschedule_request_fee on public.reschedule_requests;
create trigger trg_set_reschedule_request_fee
before insert on public.reschedule_requests
for each row execute function public.set_reschedule_request_fee();

-- A reschedule that costs nothing completes at once: it moves the date
-- exactly as approving a paid reschedule does (same three columns).
create or replace function public.complete_free_reschedule()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_res public.reservations%rowtype;
begin
  if auth.uid() is null or coalesce(public.get_my_role(), '') in ('manager', 'admin') then
    return new;
  end if;
  if new.fee_amount is null or new.fee_amount > 0
     or lower(coalesce(new.status, '')) <> 'approved_pending_payment' then
    return new;
  end if;

  select * into v_res from public.reservations where reservation_id = new.reservation_id;

  update public.reservations
  set event_date = new.requested_date,
      event_time = new.requested_time,
      status     = 'rescheduled'
  where reservation_id = new.reservation_id;

  update public.reschedule_requests
  set status = 'completed',
      reviewed_at = now()
  where reschedule_request_id = new.reschedule_request_id;

  if v_res.user_id is not null then
    insert into public.notifications (user_id, type, title, body, link)
    values (
      v_res.user_id,
      'reservation_status',
      'Reservation Rescheduled',
      'Your reservation' || coalesce(' ' || v_res.reservation_number::text, '') || ' has been moved to '
        || to_char(new.requested_date::timestamp, 'FMMonth DD, YYYY')
        || '. No reschedule fee applies because you gave enough notice.',
      '/account.html'
    );
  end if;

  insert into public.notifications (user_id, type, title, body, link)
  select p.user_id,
         'reservation_status',
         'Reservation Rescheduled',
         coalesce(v_res.contact_name, 'A customer') || ' moved reservation'
           || coalesce(' ' || v_res.reservation_number::text, '') || ' to '
           || to_char(new.requested_date::timestamp, 'FMMonth DD, YYYY') || ' (no reschedule fee).',
         '/admin/reservation-details.html?id=' || new.reservation_id::text
  from public.profiles p
  where p.role = 'manager';

  return new;
end;
$$;

drop trigger if exists trg_complete_free_reschedule on public.reschedule_requests;
create trigger trg_complete_free_reschedule
after insert on public.reschedule_requests
for each row execute function public.complete_free_reschedule();

-- ── 5. Payment validation: expect the frozen amount ─────────────────────────
-- Reproduced from 20261104_auto_cancel_fee_insert_bypass.sql with only the
-- two blocks marked 20261206 changed (reschedule_fee and cancellation_fee).
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

    -- 20261206: the fee frozen on the request when it was submitted decides
    -- the amount. Requests made before this migration have none (null) and
    -- keep the old flat reschedule_fee, so nothing already in flight changes.
    v_expected_fee := coalesce(
      v_reschedule.fee_amount,
      (v_payment_rules->>'reschedule_fee')::numeric,
      3000
    );
    if v_reschedule.fee_amount is not null and v_reschedule.fee_amount <= 0 then
      raise exception 'No reschedule fee is due for this request.';
    end if;
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

    -- 20261206: the fee frozen on the reservation when the customer asked to
    -- cancel decides the amount. A cancellation with no frozen figure (the
    -- overdue auto-cancel, or one already in flight before this migration)
    -- keeps the flat onsite/offsite fee.
    v_expected_fee := coalesce(
      v_reservation.cancellation_fee_amount,
      (v_payment_rules->>(case when lower(coalesce(v_reservation.location_type, '')) = 'offsite'
        then 'cancellation_fee_offsite' else 'cancellation_fee_onsite' end))::numeric,
      case when lower(coalesce(v_reservation.location_type, '')) = 'offsite' then 2000 else 500 end
    );
    if v_reservation.cancellation_fee_amount is not null and v_reservation.cancellation_fee_amount <= 0 then
      raise exception 'No cancellation fee is due for this reservation.';
    end if;
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

notify pgrst, 'reload schema';
