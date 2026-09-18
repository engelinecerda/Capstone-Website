-- BUG-01 (Critical): PENDING bookings incorrectly lock daily scope capacity
-- and block Admin/Manager approvals.
--
-- Root cause: a reservation merely submitted by a customer and not yet
-- reviewed by staff ('pending') was being treated identically to an
-- 'approved'/'confirmed'/'rescheduled' one for capacity purposes, in every
-- layer that computes "is this date/scope taken":
--   - enforce_reservation_capacity()'s overlap-EXISTS check and daily-count
--     check both included 'pending' in the blocking-status list compared
--     against OTHER rows.
--   - Since this trigger fires on every UPDATE (not just INSERT — no
--     column filter on the trigger, see reservations_enforce_capacity),
--     an admin approving reservation A re-runs these same checks. If a
--     separate, still-PENDING reservation B existed for the same
--     date+scope, B counted as "already booked" and blocked A's approval
--     outright (exclusion is only `r.reservation_id <> new.reservation_id`,
--     i.e. only the row being updated is excluded — no allowance for "the
--     other row is only pending, not yet real").
--   - The customer-facing availability calendar (get_available_start_times,
--     via is_capacity_blocking_reservation_status()) and two admin JS
--     constants (admin_reservation_details.js, admin_availability_
--     calendar.js CAPACITY_BLOCKING_STATUSES) all mirrored the same
--     'pending'-is-blocking assumption.
--
-- Fix: a merely-pending request is provisional, not a hold — only
-- 'approved'/'confirmed'/'rescheduled' (and, for the shared helper,
-- 'cancellation_requested', a reservation that WAS already approved and is
-- now in a fee-hold) should lock a date/scope. Multiple customers may now
-- submit competing pending requests for the same slot; staff approve
-- whichever one they choose (the trigger still correctly blocks approving
-- a SECOND one once the first is approved, since 'approved' remains a
-- blocking status). 'pending' is deliberately KEPT in this function's
-- top-of-section early-return gate (`new.status not in (...)`) — that gate
-- only decides whether THIS row's own booking_scope/event_end_time get
-- computed and whether it gets checked against EXISTING approved/confirmed
-- bookings, which must still happen for a pending insert.
--
-- Also restores capacity logic this function lost in
-- 20261001_package_discounts.sql: that migration's `create or replace`
-- was copied from the older 20260731 shape (per its own comment, "full
-- function body copied from the existing migration with only [the
-- discount] line touched") rather than from 20260920_package_extension_
-- hours.sql, which was actually the latest version at the time — so it
-- silently dropped the location_type validation (20260803/20260909), the
-- scope_capacity-aware daily-count cap that replaced a blanket "already
-- booked" EXISTS (20260905_fix_reservation_capacity_blanket_block.sql),
-- the count_held_reschedule_conflicts()/count_held_extension_conflicts()
-- integration (20260909/20260920), and the approved-extension-hours-aware
-- event_end_time computation (20260920). This migration rebuilds from that
-- correct 20260920 base, keeps the discount_amount price-floor adjustment,
-- and applies the pending-status fix on top — so it is the single
-- authoritative version regardless of which of the many prior migrations
-- touching this function were actually applied to the live database.

create or replace function public.enforce_reservation_capacity()
returns trigger
language plpgsql
as $$
declare
  v_package_name text;
  v_package_location_type text;
  v_duration_hours integer := 3;
  v_package_price numeric;
  v_package_min_guests integer;
  v_package_max_guests integer;
  v_package_is_active boolean;
  v_addon_price numeric := 0;
  v_is_catering boolean;
  v_scope text;
  v_start_time time;
  v_end_time time;
  v_scope_label text;
  v_event_label text;
  v_capacity integer := 2;
  v_scope_override integer;
  v_daily_count integer;
  v_held_daily_count integer;
  v_approved_extension_hours numeric := 0;
begin
  select p.package_name, p.location_type, coalesce(p.duration_hours, 3), p.price, p.min_guests, p.max_guests, p.is_active
  into v_package_name, v_package_location_type, v_duration_hours, v_package_price, v_package_min_guests, v_package_max_guests, v_package_is_active
  from public.package p
  where p.package_id = new.package_id;

  -- ── Package integrity (Reservation Form ↔ Admin Inventory single source) ──
  if (
    tg_op = 'INSERT'
    or new.package_id is distinct from old.package_id
    or new.add_on_id is distinct from old.add_on_id
    or new.guest_count is distinct from old.guest_count
    or new.total_price is distinct from old.total_price
    or new.location_type is distinct from old.location_type
  ) then

    if new.package_id is null then
      raise exception using errcode = 'P0001', message = 'A package selection is required.';
    end if;

    if v_package_name is null then
      raise exception using errcode = 'P0001', message = 'Selected package could not be found.';
    end if;

    if v_package_is_active is not true then
      raise exception using errcode = 'P0001', message = 'Selected package is no longer available.';
    end if;

    -- A package configured as onsite-only or offsite-only cannot be booked
    -- under the other location type. 'both' packages are valid either way.
    if v_package_location_type is not null
       and v_package_location_type <> 'both'
       and v_package_location_type is distinct from new.location_type then
      raise exception using errcode = 'P0001',
        message = 'Selected package is not available for the chosen location type.';
    end if;

    if v_package_min_guests is not null and new.guest_count < v_package_min_guests then
      raise exception using errcode = 'P0001',
        message = format('Guest count must be at least %s for this package.', v_package_min_guests);
    end if;

    if v_package_max_guests is not null and new.guest_count > v_package_max_guests then
      raise exception using errcode = 'P0001',
        message = format('Guest count must be at most %s for this package.', v_package_max_guests);
    end if;

    v_is_catering := (new.location_type = 'offsite' and lower(v_package_name) like '%catering%');

    if not v_is_catering then
      v_addon_price := 0;
      if new.add_on_id is not null then
        select coalesce(p2.price, 0) into v_addon_price
        from public.package p2
        where p2.package_id = new.add_on_id;
      end if;

      if new.total_price < (coalesce(v_package_price, 0) - coalesce(new.discount_amount, 0) + coalesce(v_addon_price, 0)) then
        raise exception using errcode = 'P0001',
          message = 'Total price cannot be less than the selected package price.';
      end if;
    end if;

  end if;

  -- ── Scheduling / capacity ──────────
  v_scope := public.normalize_booking_scope(new.location_type, v_package_name);
  new.booking_scope := v_scope;

  v_start_time := public.parse_event_time_text(new.event_time);

  -- Extension Hours: fold in every APPROVED extension's hours so
  -- event_end_time always reflects the reservation's true effective end
  -- time, regardless of what triggered this recompute.
  if new.reservation_id is not null then
    select coalesce(sum(re.requested_hours), 0)
    into v_approved_extension_hours
    from public.reservation_extensions re
    where re.reservation_id = new.reservation_id
      and re.status = 'approved';
  end if;

  if v_start_time is not null and coalesce(v_duration_hours, 0) > 0 then
    v_end_time := (v_start_time + make_interval(hours => v_duration_hours) + make_interval(secs => coalesce(v_approved_extension_hours, 0) * 3600))::time;
  else
    v_end_time := null;
  end if;
  new.event_end_time := v_end_time;

  -- This row's own status still needs to reach the checks below while
  -- pending (so its scope/end-time are stored, and it's still rejected if
  -- it genuinely overlaps something already approved) — 'pending' stays in
  -- this gate. What changes below is which OTHER rows' statuses count as
  -- blocking.
  if lower(coalesce(new.status, '')) not in ('pending', 'approved', 'confirmed', 'rescheduled') then
    return new;
  end if;

  if new.event_date is null or v_scope is null then
    return new;
  end if;

  -- BUG-01 fix: a merely-pending OTHER reservation no longer counts as an
  -- overlap/capacity block — only approved/confirmed/rescheduled ones do.
  if exists (
    select 1
    from public.reservations r
    left join public.package rp on rp.package_id = r.package_id
    where r.event_date = new.event_date
      and lower(coalesce(r.status, '')) in ('approved', 'confirmed', 'rescheduled')
      and coalesce(r.booking_scope, public.normalize_booking_scope(r.location_type, rp.package_name)) = v_scope
      and r.reservation_id <> coalesce(new.reservation_id, '00000000-0000-0000-0000-000000000000'::uuid)
      and public.booking_times_overlap(
        v_start_time,
        v_end_time,
        public.parse_event_time_text(r.event_time),
        coalesce(
          r.event_end_time,
          (
            public.parse_event_time_text(r.event_time)
            + make_interval(hours => coalesce(rp.duration_hours, 3))
          )::time
        )
      )
  ) or public.count_held_reschedule_conflicts(
    new.event_date, v_scope, v_start_time, v_end_time, 0,
    coalesce(new.reservation_id, '00000000-0000-0000-0000-000000000000'::uuid)
  ) > 0 or public.count_held_extension_conflicts(
    new.event_date, v_scope, v_start_time, v_end_time, 0,
    coalesce(new.reservation_id, '00000000-0000-0000-0000-000000000000'::uuid)
  ) > 0 then
    raise exception using
      errcode = 'P0001',
      message = 'This reservation overlaps an existing booking for the selected date and scope.';
  end if;

  -- Daily capacity cap — same BUG-01 fix: pending siblings no longer count
  -- toward the scope's daily count, so admins can approve one of several
  -- competing pending requests, and customers can submit a pending request
  -- for a slot another customer already has pending (staff adjudicate).
  select default_slot_capacity
  into v_capacity
  from public.scheduling_settings where id = true;
  v_capacity := coalesce(v_capacity, 2);

  select capacity into v_scope_override from public.scope_capacity where scope = v_scope;
  v_capacity := coalesce(v_scope_override, v_capacity);

  select count(*)
  into v_daily_count
  from public.reservations r
  left join public.package rp on rp.package_id = r.package_id
  where r.event_date = new.event_date
    and lower(coalesce(r.status, '')) in ('approved', 'confirmed', 'rescheduled')
    and coalesce(r.booking_scope, public.normalize_booking_scope(r.location_type, rp.package_name)) = v_scope
    and r.reservation_id <> coalesce(new.reservation_id, '00000000-0000-0000-0000-000000000000'::uuid);

  v_held_daily_count := public.count_held_reschedule_conflicts(
    new.event_date, v_scope, null, null, 0,
    coalesce(new.reservation_id, '00000000-0000-0000-0000-000000000000'::uuid)
  );

  if coalesce(v_daily_count, 0) + coalesce(v_held_daily_count, 0) >= v_capacity then
    v_scope_label := case v_scope
      when 'onsite_vip' then 'VIP'
      when 'onsite_main_hall' then 'Main Hall'
      when 'offsite' then 'Off-site'
      else 'Selected'
    end;
    v_event_label := to_char(new.event_date::timestamp, 'FMMonth DD, YYYY');

    raise exception using
      errcode = 'P0001',
      message = v_scope_label || ' has reached its daily booking limit for ' || v_event_label || '.';
  end if;

  return new;
end;
$$;

-- Same fix for the shared helper used by the customer calendar
-- (get_available_start_times()) and the reschedule-hold machinery
-- (enforce_reschedule_capacity(), count_held_reschedule_conflicts(),
-- expire_reschedule_holds()) — 'pending' removed; 'cancellation_requested'
-- stays (that status means a reservation that WAS already approved and is
-- now mid fee-hold, a genuine capacity lock, unlike a fresh pending
-- request).
create or replace function public.is_capacity_blocking_reservation_status(p_status text)
returns boolean
language sql
immutable
as $$
  select lower(coalesce(p_status, '')) in (
    'pending_review',
    'for_finalization',
    'for_contract_signing',
    'approved',
    'confirmed',
    'partially_paid',
    'fully_paid',
    'rescheduled',
    'cancellation_requested'
  )
$$;
