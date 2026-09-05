-- Fix: enforce_reservation_capacity() was rejecting a second, genuinely
-- non-overlapping booking in the same scope+date with "<Scope> is already
-- booked on <date>." That check was a blanket EXISTS (any other blocking
-- reservation in the same scope/date) with no time comparison and no
-- capacity awareness — so it fired even when the scope's real capacity
-- (scope_capacity.capacity, e.g. onsite_vip = 2) hadn't been reached yet.
-- This contradicted get_available_start_times(), which already allows a
-- second non-overlapping slot once the true daily cap isn't hit, so the
-- calendar showed the second time as available and submission then failed.
--
-- Fix: replace the blanket EXISTS with the same daily-capacity COUNT logic
-- get_available_start_times() uses (scope_capacity override, falling back
-- to scheduling_settings.default_slot_capacity, default 2), counting
-- blocking-status reservations plus held reschedule conflicts for that
-- scope/date. The first check (actual time-overlap rejection) is unchanged.

create or replace function public.enforce_reservation_capacity()
returns trigger
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

      if new.total_price < (coalesce(v_package_price, 0) + coalesce(v_addon_price, 0)) then
        raise exception using errcode = 'P0001',
          message = 'Total price cannot be less than the selected package price.';
      end if;
    end if;

  end if;

  -- ── Scheduling / capacity ──────────
  v_scope := public.normalize_booking_scope(new.location_type, v_package_name);
  new.booking_scope := v_scope;

  v_start_time := public.parse_event_time_text(new.event_time);
  if v_start_time is not null and coalesce(v_duration_hours, 0) > 0 then
    v_end_time := (v_start_time + make_interval(hours => v_duration_hours))::time;
  else
    v_end_time := null;
  end if;
  new.event_end_time := v_end_time;

  if lower(coalesce(new.status, '')) not in ('pending', 'approved', 'confirmed', 'rescheduled') then
    return new;
  end if;

  if new.event_date is null or v_scope is null then
    return new;
  end if;

  if exists (
    select 1
    from public.reservations r
    left join public.package rp on rp.package_id = r.package_id
    where r.event_date = new.event_date
      and lower(coalesce(r.status, '')) in ('pending', 'approved', 'confirmed', 'rescheduled')
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
  ) > 0 then
    raise exception using
      errcode = 'P0001',
      message = 'This reservation overlaps an existing booking for the selected date and scope.';
  end if;

  -- Daily capacity cap — mirrors get_available_start_times() exactly, so a
  -- reservation submission is never rejected for a scope/date the customer's
  -- own calendar just showed as available. Counts existing blocking-status
  -- reservations (not a blanket "any exists") plus still-held reschedule
  -- conflicts for the whole day, against the scope's real capacity.
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
    and lower(coalesce(r.status, '')) in ('pending', 'approved', 'confirmed', 'rescheduled')
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
$$ language plpgsql;
