-- Additional Per-Head — let a customer add guests beyond a package's normal
-- ceiling at a configured per-person price (e.g. an All-In package priced
-- for up to 50 pax, +₱200/head beyond that).
--
-- Mapping onto this codebase's actual schema (there is no single "base pax"
-- column today): public.package already has min_guests/max_guests — a
-- RANGE the customer's normal guest-count field is hard-clamped to
-- (js/reservations.js's clampGuestCountToSelection() sets the input's
-- native max attribute to max_guests). That existing ceiling IS this
-- feature's "base pax" — additional heads are guests booked ON TOP OF
-- max_guests, not a relaxation of the normal guest-count field itself.
-- public.venue.capacity (20260725_bookable_inventory.sql) is already the
-- room's max guest headcount, so "venue.max_capacity" needs no new column
-- either — this migration only adds the per-package per-head configuration
-- and the reservation-level snapshot.
--
-- Combo (multi-scope) packages are explicitly NOT supported for additional
-- heads — they never get a resolved venue_id (20261016_venue_capacity_and_
-- selection.sql's own documented boundary: a single venue_id can't express
-- "this reservation occupies two rooms at once"), so there is no single
-- venue to size-check against. An onsite additional-head request on such a
-- package is rejected rather than silently left unchecked.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 1. Schema ────────────────────────────────────────────────────────────

alter table public.package
  add column if not exists allow_additional_head boolean not null default false,
  add column if not exists price_per_additional_head numeric(12,2)
    check (price_per_additional_head is null or price_per_additional_head >= 0),
  add column if not exists max_additional_heads int
    check (max_additional_heads is null or max_additional_heads >= 0);

alter table public.package
  drop constraint if exists package_additional_head_price_required;

alter table public.package
  add constraint package_additional_head_price_required
  check (allow_additional_head = false or price_per_additional_head is not null);

-- Frozen at booking time, same reasoning as service_charge_percent/amount
-- and discount_percent/amount/label alongside them — a later admin price
-- change must never reprice an existing booking or its signed contract.
alter table public.reservations
  add column if not exists additional_heads int not null default 0 check (additional_heads >= 0),
  add column if not exists additional_head_price numeric(12,2),
  add column if not exists additional_head_charge numeric(12,2) not null default 0;

-- ── 2. enforce_reservation_capacity() — additional-head resolution/
--    validation, layered onto the 20261016 body verbatim otherwise ───────

create or replace function public.enforce_reservation_capacity()
returns trigger
language plpgsql
as $$
declare
  v_package_name text;
  v_package_location_type text;
  v_package_scopes text[];
  v_duration_hours integer := 3;
  v_package_price numeric;
  v_package_min_guests integer;
  v_package_max_guests integer;
  v_package_is_active boolean;
  v_addon_price numeric := 0;
  v_is_catering boolean;
  v_scopes text[];
  v_single_scope text;
  v_start_time time;
  v_end_time time;
  v_scope_label text;
  v_event_label text;
  v_capacity integer := 2;
  v_scope_override integer;
  v_daily_count integer;
  v_held_daily_count integer;
  v_held_conflict boolean;
  v_approved_extension_hours numeric := 0;
  v_rules_json jsonb;
  v_min_advance_days integer := 14;
  v_max_advance_days integer := 365;
  v_advance_event_type_override integer;
  v_days_until integer;
  v_venue_id uuid;
  v_venue_count integer;
  v_venue_capacity_override integer;
  v_venue_name text;
  v_venue_conflict boolean;
  v_allow_additional_head boolean;
  v_price_per_additional_head numeric;
  v_max_additional_heads integer;
  v_venue_capacity integer;
begin
  select p.package_name, p.location_type, p.booking_scope, coalesce(p.duration_hours, 3), p.price, p.min_guests, p.max_guests, p.is_active
  into v_package_name, v_package_location_type, v_package_scopes, v_duration_hours, v_package_price, v_package_min_guests, v_package_max_guests, v_package_is_active
  from public.package p
  where p.package_id = new.package_id;

  -- ── Package integrity (Reservation Form ↔ Admin Inventory single source) ──
  if (
    tg_op = 'INSERT'
    or new.package_id is distinct from old.package_id
    or new.add_on_id is distinct from old.add_on_id
    or new.guest_count is distinct from old.guest_count
    or new.additional_heads is distinct from old.additional_heads
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

    -- Additional Per-Head: guest_count above max_guests is only ever valid
    -- when it's backed by additional_heads (allow-flag, cap, and — for
    -- onsite — venue capacity are all validated further below, once the
    -- venue is resolved). Recompute guest_count from the package ceiling +
    -- additional_heads here so it can never drift from what was actually
    -- charged for — the same "server always recomputes, never trusts the
    -- client's math" rule this function already applies to booking_scope/
    -- venue_id/event_end_time. When no additional heads are requested,
    -- behavior is completely unchanged from before this feature existed.
    if coalesce(new.additional_heads, 0) > 0 then
      new.guest_count := coalesce(v_package_max_guests, new.guest_count) + new.additional_heads;
    elsif v_package_max_guests is not null and new.guest_count > v_package_max_guests then
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

  -- ── BUG-02 fix: server-side advance-notice window, same source/shape as
  -- enforce_reschedule_capacity()'s existing check ──────────────────────────
  if new.event_date is not null and (tg_op = 'INSERT' or new.event_date is distinct from old.event_date) then
    select ss.setting_value::jsonb into v_rules_json
    from public.system_settings ss
    where ss.setting_key = 'reservation_rules';

    v_min_advance_days := coalesce((v_rules_json->>'min_advance_days')::integer, 14);
    v_max_advance_days := coalesce((v_rules_json->>'max_advance_days')::integer, 365);

    select et.min_advance_days into v_advance_event_type_override
    from public.event_types et
    where et.name = new.event_type;

    v_min_advance_days := coalesce(v_advance_event_type_override, v_min_advance_days);

    v_days_until := new.event_date - current_date;

    if v_days_until < v_min_advance_days then
      raise exception using
        errcode = 'P0001',
        message = 'This date is too soon — please choose a date at least ' || v_min_advance_days || ' day(s) from today.';
    end if;

    if v_days_until > v_max_advance_days then
      raise exception using
        errcode = 'P0001',
        message = 'This date is too far in advance — please choose a date within ' || v_max_advance_days || ' day(s) from today.';
    end if;
  end if;

  -- ── Scheduling / capacity ──────────
  v_scopes := coalesce(v_package_scopes, array[public.normalize_booking_scope(new.location_type, v_package_name)]);
  new.booking_scope := v_scopes;

  -- ── Venue resolution ────────────────────────────────────────────────────
  -- Only single-scope packages get a resolved venue — a combo (2-scope)
  -- package keeps venue_id null and falls through to pure scope checks
  -- below, same as a package with zero mapped venues.
  v_venue_id := null;
  if v_scopes is not null and array_length(v_scopes, 1) = 1 then
    select count(*) into v_venue_count
    from public.package_venue pv
    join public.venue v on v.venue_id = pv.venue_id and v.is_active
    where pv.package_id = new.package_id;

    if new.venue_id is not null then
      -- Client supplied one (multi-venue package) — validate it's actually
      -- one of this package's mapped, active venues rather than trusting it.
      if not exists (
        select 1 from public.package_venue pv
        join public.venue v on v.venue_id = pv.venue_id and v.is_active
        where pv.package_id = new.package_id and pv.venue_id = new.venue_id
      ) then
        raise exception using errcode = 'P0001',
          message = 'Selected venue is not available for this package.';
      end if;
      v_venue_id := new.venue_id;
    elsif v_venue_count = 1 then
      -- Exactly one candidate — resolve it automatically, no client choice needed.
      select pv.venue_id into v_venue_id
      from public.package_venue pv
      join public.venue v on v.venue_id = pv.venue_id and v.is_active
      where pv.package_id = new.package_id;
    end if;
    -- v_venue_count = 0 or > 1 with no client selection: v_venue_id stays
    -- null, falls back to scope-only checks below (matches today exactly).
  end if;
  new.venue_id := v_venue_id;

  -- ── Additional Per-Head: allow-flag, cap, price, and (onsite only) venue
  -- capacity — placed here so the already-resolved v_venue_id is available.
  -- Same guard as the package-integrity block above (v_is_catering/
  -- v_addon_price, set there, are always fresh whenever this one runs too).
  if (
    tg_op = 'INSERT'
    or new.package_id is distinct from old.package_id
    or new.add_on_id is distinct from old.add_on_id
    or new.guest_count is distinct from old.guest_count
    or new.additional_heads is distinct from old.additional_heads
    or new.total_price is distinct from old.total_price
    or new.location_type is distinct from old.location_type
  ) then
    select p.allow_additional_head, p.price_per_additional_head, p.max_additional_heads
    into v_allow_additional_head, v_price_per_additional_head, v_max_additional_heads
    from public.package p
    where p.package_id = new.package_id;

    if coalesce(new.additional_heads, 0) > 0 then
      if not coalesce(v_allow_additional_head, false) then
        raise exception using errcode = 'P0001',
          message = 'Selected package does not allow additional guests.';
      end if;

      if v_price_per_additional_head is null then
        raise exception using errcode = 'P0001',
          message = 'This package is not configured for additional guests.';
      end if;

      if v_max_additional_heads is not null and new.additional_heads > v_max_additional_heads then
        raise exception using errcode = 'P0001',
          message = format('This package allows at most %s additional guest(s).', v_max_additional_heads);
      end if;

      -- Onsite: total guests must fit the resolved venue. A combo package
      -- (never gets a venue_id) or one somehow still unresolved fails
      -- closed here rather than booking an unchecked headcount.
      if new.location_type = 'onsite' then
        if v_venue_id is null then
          raise exception using errcode = 'P0001',
            message = 'Could not verify venue capacity for additional guests — please reselect your room.';
        end if;

        select v.capacity, v.name into v_venue_capacity, v_venue_name
        from public.venue v where v.venue_id = v_venue_id;

        if v_venue_capacity is not null and new.guest_count > v_venue_capacity then
          raise exception using errcode = 'P0001',
            message = format('%s holds %s guests — you can add at most %s additional guest(s).',
              coalesce(v_venue_name, 'The selected venue'),
              v_venue_capacity,
              greatest(v_venue_capacity - coalesce(v_package_max_guests, 0), 0));
        end if;
      end if;
      -- Offsite: no venue, no capacity check — per spec, capped only by
      -- max_additional_heads (already enforced above).

      new.additional_head_price  := v_price_per_additional_head;
      new.additional_head_charge := new.additional_heads * v_price_per_additional_head;
    else
      new.additional_heads       := 0;
      new.additional_head_price  := null;
      new.additional_head_charge := 0;
    end if;

    -- Extends the price-floor check above with the additional-head charge —
    -- same floor, one more term, same catering exemption (no single
    -- package.price to floor a cart-priced booking against).
    if not v_is_catering and new.total_price < (
      coalesce(v_package_price, 0) - coalesce(new.discount_amount, 0)
      + coalesce(v_addon_price, 0) + coalesce(new.additional_head_charge, 0)
    ) then
      raise exception using errcode = 'P0001',
        message = 'Total price cannot be less than the selected package price plus any additional guest charge.';
    end if;
  end if;

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
  -- blocking (BUG-01 fix).
  if lower(coalesce(new.status, '')) not in ('pending', 'approved', 'confirmed', 'rescheduled') then
    return new;
  end if;

  if new.event_date is null or v_scopes is null or array_length(v_scopes, 1) is null then
    return new;
  end if;

  -- Held-hold conflicts (reschedule/extension) are still checked one scope
  -- at a time — count_held_reschedule_conflicts()/count_held_extension_
  -- conflicts() take a single scope by design, called once per element of
  -- this reservation's set instead of teaching them a second, array-typed
  -- signature. Left scope-level even once venues are in play (see header).
  v_held_conflict := false;
  foreach v_single_scope in array v_scopes loop
    if public.count_held_reschedule_conflicts(
      new.event_date, v_single_scope, v_start_time, v_end_time, 0,
      coalesce(new.reservation_id, '00000000-0000-0000-0000-000000000000'::uuid)
    ) > 0 or public.count_held_extension_conflicts(
      new.event_date, v_single_scope, v_start_time, v_end_time, 0,
      coalesce(new.reservation_id, '00000000-0000-0000-0000-000000000000'::uuid)
    ) > 0 then
      v_held_conflict := true;
      exit;
    end if;
  end loop;

  -- Venue-aware overlap: two reservations only conflict on venue grounds
  -- when BOTH have a resolved venue_id and it's the same one; otherwise
  -- (either side unresolved) fall back to the original scope-overlap
  -- check, which never under-blocks a real conflict.
  select exists (
    select 1
    from public.reservations r
    left join public.package rp on rp.package_id = r.package_id
    where r.event_date = new.event_date
      and lower(coalesce(r.status, '')) in ('approved', 'confirmed', 'rescheduled')
      and r.reservation_id <> coalesce(new.reservation_id, '00000000-0000-0000-0000-000000000000'::uuid)
      and (
        (v_venue_id is not null and r.venue_id is not null and r.venue_id = v_venue_id)
        or (
          not (v_venue_id is not null and r.venue_id is not null)
          and coalesce(r.booking_scope, array[public.normalize_booking_scope(r.location_type, rp.package_name)]) && v_scopes
        )
      )
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
  ) into v_venue_conflict;

  if v_venue_conflict or v_held_conflict then
    raise exception using
      errcode = 'P0001',
      message = 'This reservation overlaps an existing booking for the selected date and scope.';
  end if;

  -- Daily capacity cap. When a venue is resolved, check that venue's own
  -- daily count/limit only (skipping its scope's cap, since the venue-level
  -- check is strictly more specific). Otherwise, walk every scope in this
  -- reservation's set exactly as before.
  v_event_label := to_char(new.event_date::timestamp, 'FMMonth DD, YYYY');

  if v_venue_id is not null then
    select default_slot_capacity
    into v_capacity
    from public.scheduling_settings where id = true;
    v_capacity := coalesce(v_capacity, 2);

    select capacity into v_venue_capacity_override from public.venue_capacity where venue_id = v_venue_id;
    v_capacity := coalesce(v_venue_capacity_override, v_capacity);

    select count(*)
    into v_daily_count
    from public.reservations r
    where r.event_date = new.event_date
      and lower(coalesce(r.status, '')) in ('approved', 'confirmed', 'rescheduled')
      and r.venue_id = v_venue_id
      and r.reservation_id <> coalesce(new.reservation_id, '00000000-0000-0000-0000-000000000000'::uuid);

    if coalesce(v_daily_count, 0) >= v_capacity then
      select v.name into v_venue_name from public.venue v where v.venue_id = v_venue_id;
      raise exception using
        errcode = 'P0001',
        message = coalesce(v_venue_name, 'Selected venue') || ' has reached its daily booking limit for ' || v_event_label || '.';
    end if;
  else
    foreach v_single_scope in array v_scopes loop
      select default_slot_capacity
      into v_capacity
      from public.scheduling_settings where id = true;
      v_capacity := coalesce(v_capacity, 2);

      select capacity into v_scope_override from public.scope_capacity where scope = v_single_scope;
      v_capacity := coalesce(v_scope_override, v_capacity);

      select count(*)
      into v_daily_count
      from public.reservations r
      left join public.package rp on rp.package_id = r.package_id
      where r.event_date = new.event_date
        and lower(coalesce(r.status, '')) in ('approved', 'confirmed', 'rescheduled')
        and v_single_scope = any(coalesce(r.booking_scope, array[public.normalize_booking_scope(r.location_type, rp.package_name)]))
        and r.reservation_id <> coalesce(new.reservation_id, '00000000-0000-0000-0000-000000000000'::uuid);

      v_held_daily_count := public.count_held_reschedule_conflicts(
        new.event_date, v_single_scope, null, null, 0,
        coalesce(new.reservation_id, '00000000-0000-0000-0000-000000000000'::uuid)
      );

      if coalesce(v_daily_count, 0) + coalesce(v_held_daily_count, 0) >= v_capacity then
        v_scope_label := case v_single_scope
          when 'onsite_vip' then 'VIP'
          when 'onsite_main_hall' then 'Main Hall'
          when 'offsite' then 'Off-site'
          else 'Selected'
        end;

        raise exception using
          errcode = 'P0001',
          message = v_scope_label || ' has reached its daily booking limit for ' || v_event_label || '.';
      end if;
    end loop;
  end if;

  return new;
end;
$$;
