-- Per-venue capacity + booking, for onsite rooms (public.venue).
--
-- Today, capacity/conflict checking is keyed entirely to booking_scope (the
-- 3-value onsite_vip / onsite_main_hall / offsite classification) — public.venue
-- (the actual named rooms an admin manages under Bookable Inventory > Venues,
-- e.g. "VIP Room A", "VIP Room B" both mapped to the same onsite_vip scope)
-- has NO relationship to reservations at all: no reservations.venue_id column,
-- not read by enforce_reservation_capacity()/enforce_reschedule_capacity()/
-- get_available_start_times(). Two different VIP rooms currently block each
-- other on the calendar as if they were the same physical space, because the
-- system literally can't tell them apart — see 20260801_availability_
-- scheduling.sql's own "Scope, not venue" comment, which flagged this
-- explicitly as future, out-of-scope work at the time.
--
-- This migration adds that missing layer as a REFINEMENT of the existing
-- scope-based system, not a replacement:
--   - reservations.venue_id (nullable) — which specific room, if resolved.
--   - venue_capacity — same shape as scope_capacity, keyed to venue_id.
--   - enforce_reservation_capacity() resolves/validates venue_id: a package
--     mapped to exactly one active venue (package_venue) auto-resolves; a
--     package mapped to 2+ needs the client to supply one (new venue picker
--     in the booking flow), and it's validated against package_venue either
--     way. A package mapped to 0 venues, or a multi-scope ("combo") package,
--     leaves venue_id null — those keep today's pure scope-based behavior
--     unchanged. Combo packages occupying two scopes at once (e.g. a "Plus"
--     package using both VIP and Main Hall simultaneously) are deliberately
--     NOT given per-venue resolution here — a single venue_id can't express
--     "this reservation occupies two specific rooms at once", and that's a
--     genuinely separate design problem left for later, matching this
--     migration's own "refinement, not replacement" scope.
--   - Overlap/capacity checks: when BOTH sides of a comparison have a
--     resolved venue_id, they only conflict if it's the SAME venue (so two
--     different VIP rooms stop blocking each other). Whenever either side
--     is unresolved, the check conservatively falls back to the existing
--     scope-overlap logic — this never UNDER-blocks a real conflict, it can
--     only ever be as strict as today until every relevant row has a
--     resolved venue.
--   - get_available_start_times() gains an optional p_venue_id parameter,
--     same fallback rule, so the customer-facing time grid reflects the
--     tighter check once a venue is chosen.
--
-- Deliberately NOT touched: get_booking_availability() and
-- get_booking_calendar_availability() (the month-view calendar's coarse
-- "is this date open" indicators) stay scope-level only. The actual gate
-- against double-booking a room is the insert/reschedule triggers below —
-- both venue-aware — so no double-booking can occur; the calendar's day
-- tint can, in principle, be slightly more conservative than reality once
-- two same-scope venues both have room on a given date. Same kind of
-- coarse-vs-fine layering this system already has elsewhere (e.g. the flat
-- "2 reservations/day" cap sitting alongside per-scope capacity).
-- count_held_reschedule_conflicts() / count_held_extension_conflicts() are
-- also left scope-level only — held reschedule/extension holds fall back to
-- the conservative (over-blocking, never under-blocking) scope check even
-- once venues are in play, rather than teaching two more functions a second
-- signature for a rarer edge case.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 1. Schema ────────────────────────────────────────────────────────────

alter table public.reservations
  add column if not exists venue_id uuid references public.venue(venue_id) on delete set null;

create table if not exists public.venue_capacity (
  venue_id   uuid primary key references public.venue(venue_id) on delete cascade,
  capacity   int check (capacity is null or capacity >= 1),
  updated_at timestamptz not null default now()
);

alter table public.venue_capacity enable row level security;

drop policy if exists "Public read venue capacity" on public.venue_capacity;
create policy "Public read venue capacity" on public.venue_capacity for select using (true);

drop policy if exists "Admin manage venue capacity" on public.venue_capacity;
create policy "Admin manage venue capacity" on public.venue_capacity
  for all using (get_my_role() = 'admin') with check (get_my_role() = 'admin');

-- board_reservations_view selects reservations.* by name in places — adding
-- a column doesn't break a view, so no drop/recreate needed here (unlike
-- 20261010_multi_scope_packages.sql's booking_scope TYPE change).

-- ── 2. enforce_reservation_capacity() — venue resolution + venue-aware
--    overlap/capacity, layered onto the 20261012 body verbatim otherwise ──

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


-- ── 3. enforce_reschedule_capacity() — reuses the ORIGINAL reservation's
--    already-resolved venue_id (a reschedule keeps the same package, so
--    there's nothing new to resolve), venue-aware overlap/capacity layered
--    onto the 20261012 body verbatim otherwise ──────────────────────────

create or replace function public.enforce_reschedule_capacity()
returns trigger
as $$
declare
  v_reservation         public.reservations%rowtype;
  v_package_name        text;
  v_package_scopes      text[];
  v_duration_hours      integer := 3;
  v_scopes              text[];
  v_single_scope        text;
  v_start_time          time;
  v_end_time            time;
  v_weekday             integer;
  v_is_open             boolean;
  v_weekday_label       text;
  v_buffer_minutes      integer := 30;
  v_capacity            integer := 2;
  v_scope_override      integer;
  v_padded_start        time;
  v_padded_end          time;
  v_overlap_count       integer;
  v_daily_count         integer;
  v_scope_label         text;
  v_rules_json          jsonb;
  v_min_advance_days    integer := 14;
  v_max_advance_days    integer := 365;
  v_event_type_override integer;
  v_days_until          integer;
  v_venue_id            uuid;
  v_venue_capacity_override integer;
  v_venue_name          text;
  v_venue_overlap_count integer;
begin
  if lower(coalesce(new.status, 'pending')) in ('rejected', 'completed', 'withdrawn', 'expired') then
    return new;
  end if;

  select r.*
  into   v_reservation
  from   public.reservations r
  where  r.reservation_id = new.reservation_id;

  if v_reservation.reservation_id is null then
    return new;
  end if;

  select p.package_name, p.booking_scope, coalesce(p.duration_hours, 3)
  into   v_package_name, v_package_scopes, v_duration_hours
  from   public.package p
  where  p.package_id = v_reservation.package_id;

  v_scopes     := coalesce(v_package_scopes, array[public.normalize_booking_scope(v_reservation.location_type, v_package_name)]);
  v_venue_id   := v_reservation.venue_id;
  v_start_time := public.parse_event_time_text(new.requested_time);

  if v_start_time is not null and coalesce(v_duration_hours, 0) > 0 then
    v_end_time := (v_start_time + make_interval(hours => v_duration_hours))::time;
  else
    v_end_time := null;
  end if;

  if new.requested_date is null then
    return new;
  end if;

  select ss.setting_value::jsonb into v_rules_json
  from public.system_settings ss
  where ss.setting_key = 'reservation_rules';

  v_min_advance_days := coalesce((v_rules_json->>'min_advance_days')::integer, 14);
  v_max_advance_days := coalesce((v_rules_json->>'max_advance_days')::integer, 365);

  select et.min_advance_days into v_event_type_override
  from public.event_types et
  where et.name = v_reservation.event_type;

  v_min_advance_days := coalesce(v_event_type_override, v_min_advance_days);

  v_days_until := new.requested_date - current_date;

  if v_days_until < v_min_advance_days then
    raise exception using
      errcode = 'P0001',
      message = 'This date is too soon — please choose a date at least ' || v_min_advance_days || ' day(s) from today.';
  end if;

  if v_days_until > v_max_advance_days then
    raise exception using
      errcode = 'P0001',
      message = 'This date is too far in advance — please choose a date within ' || v_max_advance_days || ' days from today.';
  end if;

  v_weekday := extract(dow from new.requested_date);
  select is_open into v_is_open from public.operating_hours where weekday = v_weekday;
  if coalesce(v_is_open, true) is false then
    v_weekday_label := trim(to_char(new.requested_date::timestamp, 'FMDay'));
    raise exception using
      errcode = 'P0001',
      message = 'The café is closed on ' || v_weekday_label || 's — please choose a different date.';
  end if;

  if v_scopes is not null and array_length(v_scopes, 1) is not null and v_start_time is not null and v_end_time is not null then
    select buffer_minutes, default_slot_capacity
    into v_buffer_minutes, v_capacity
    from public.scheduling_settings where id = true;
    v_buffer_minutes := coalesce(v_buffer_minutes, 30);
    v_capacity := coalesce(v_capacity, 2);

    v_padded_start := (v_start_time - make_interval(mins => v_buffer_minutes))::time;
    v_padded_end   := (v_end_time   + make_interval(mins => v_buffer_minutes))::time;

    if v_venue_id is not null then
      select count(*)
      into v_venue_overlap_count
      from public.reservations r
      where r.event_date = new.requested_date
        and public.is_capacity_blocking_reservation_status(r.status)
        and r.reservation_id <> v_reservation.reservation_id
        and r.venue_id = v_venue_id
        and public.booking_times_overlap(
          v_padded_start,
          v_padded_end,
          coalesce(r.start_time, public.parse_event_time_text(r.event_time)),
          coalesce(r.event_end_time, (coalesce(r.start_time, public.parse_event_time_text(r.event_time)) + make_interval(hours => 3))::time)
        );
      v_overlap_count := coalesce(v_venue_overlap_count, 0);
    else
      select count(*)
      into v_overlap_count
      from public.reservations r
      left join public.package rp on rp.package_id = r.package_id
      where r.event_date = new.requested_date
        and public.is_capacity_blocking_reservation_status(r.status)
        and r.reservation_id <> v_reservation.reservation_id
        and coalesce(r.booking_scope, array[public.normalize_booking_scope(r.location_type, rp.package_name)]) && v_scopes
        and public.booking_times_overlap(
          v_padded_start,
          v_padded_end,
          coalesce(r.start_time, public.parse_event_time_text(r.event_time)),
          coalesce(
            r.event_end_time,
            (
              coalesce(r.start_time, public.parse_event_time_text(r.event_time))
              + make_interval(hours => coalesce(rp.duration_hours, 3))
            )::time
          )
        );

      -- Also count another customer's still-held reschedule request, and
      -- another reservation's still-held extension request, landing on this
      -- same slot — one scope at a time, same reasoning as the insert trigger.
      -- Left scope-level even once venues are in play (see migration header).
      foreach v_single_scope in array v_scopes loop
        v_overlap_count := v_overlap_count + public.count_held_reschedule_conflicts(
          new.requested_date, v_single_scope, v_start_time, v_end_time, v_buffer_minutes, v_reservation.reservation_id
        ) + public.count_held_extension_conflicts(
          new.requested_date, v_single_scope, v_start_time, v_end_time, v_buffer_minutes, v_reservation.reservation_id
        );
      end loop;
    end if;

    if v_overlap_count > 0 then
      if v_venue_id is not null then
        select v.name into v_venue_name from public.venue v where v.venue_id = v_venue_id;
        raise exception using
          errcode = 'P0001',
          message = coalesce(v_venue_name, 'Selected venue') || ' is already booked at that time.';
      end if;
      v_scope_label := case v_scopes[1]
        when 'onsite_vip' then 'VIP'
        when 'onsite_main_hall' then 'Main Hall'
        when 'offsite' then 'Off-site'
        else 'Selected'
      end;
      raise exception using
        errcode = 'P0001',
        message = v_scope_label || ' is already booked at that time.';
    end if;

    -- Daily capacity — venue-level when resolved (skips the scope cap,
    -- more specific wins), otherwise one scope at a time as before.
    if v_venue_id is not null then
      select default_slot_capacity into v_capacity from public.scheduling_settings where id = true;
      v_capacity := coalesce(v_capacity, 2);
      select capacity into v_venue_capacity_override from public.venue_capacity where venue_id = v_venue_id;
      v_capacity := coalesce(v_venue_capacity_override, v_capacity);

      select count(*)
      into v_daily_count
      from public.reservations r
      where r.event_date = new.requested_date
        and public.is_capacity_blocking_reservation_status(r.status)
        and r.reservation_id <> v_reservation.reservation_id
        and r.venue_id = v_venue_id;

      if v_daily_count >= v_capacity then
        select v.name into v_venue_name from public.venue v where v.venue_id = v_venue_id;
        raise exception using
          errcode = 'P0001',
          message = coalesce(v_venue_name, 'Selected venue') || ' has reached its daily booking limit for that date.';
      end if;
    else
      foreach v_single_scope in array v_scopes loop
        select default_slot_capacity into v_capacity from public.scheduling_settings where id = true;
        v_capacity := coalesce(v_capacity, 2);
        select capacity into v_scope_override from public.scope_capacity where scope = v_single_scope;
        v_capacity := coalesce(v_scope_override, v_capacity);

        select count(*)
        into v_daily_count
        from public.reservations r
        left join public.package rp on rp.package_id = r.package_id
        where r.event_date = new.requested_date
          and public.is_capacity_blocking_reservation_status(r.status)
          and r.reservation_id <> v_reservation.reservation_id
          and v_single_scope = any(coalesce(r.booking_scope, array[public.normalize_booking_scope(r.location_type, rp.package_name)]));

        v_daily_count := v_daily_count + public.count_held_reschedule_conflicts(
          new.requested_date, v_single_scope, p_exclude_reservation_id => v_reservation.reservation_id
        );

        if v_daily_count >= v_capacity then
          v_scope_label := case v_single_scope
            when 'onsite_vip' then 'VIP'
            when 'onsite_main_hall' then 'Main Hall'
            when 'offsite' then 'Off-site'
            else 'Selected'
          end;
          raise exception using
            errcode = 'P0001',
            message = v_scope_label || ' has reached its daily booking limit for that date.';
        end if;
      end loop;
    end if;
  end if;

  return new;
end;
$$ language plpgsql;


-- ── 4. get_available_start_times() — new optional p_venue_id, same
--    fallback rule as the triggers above: when supplied, checks/caps by
--    venue instead of scope. Existing callers that don't pass it (none do
--    yet — js/reservation_availability.js is updated separately) keep
--    today's exact scope-only behavior via the default null.
--
-- Adding a parameter changes this function's signature, so `create or
-- replace` would otherwise leave the old 4-arg version behind as a second,
-- ambiguous overload rather than actually replacing it — drop it first.
drop function if exists public.get_available_start_times(date, text, integer, uuid);

create or replace function public.get_available_start_times(
  p_event_date             date,
  p_scope                  text,
  p_duration_hours         integer,
  p_exclude_reservation_id uuid default null,
  p_venue_id               uuid default null
)
returns table (
  time_label   text,
  start_time   time,
  end_time     time,
  is_available boolean,
  reason       text
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_is_open          boolean;
  v_open             time;
  v_close            time;
  v_weekday          integer;
  v_interval_minutes integer := 30;
  v_duration         integer := greatest(coalesce(p_duration_hours, 1), 1);
  v_buffer_minutes   integer := 30;
  v_capacity         integer := 2;
  v_scope_override   integer;
  v_venue_capacity_override integer;
  v_last_offset      integer;
  v_daily_count      integer;
  v_held_count       integer;
  v_capacity_reached boolean;
begin
  v_weekday := extract(dow from p_event_date);

  select is_open, open_time, close_time
  into v_is_open, v_open, v_close
  from public.operating_hours
  where weekday = v_weekday;

  if coalesce(v_is_open, true) is false then
    return; -- closed this weekday — no bookable slots at all
  end if;

  v_open  := coalesce(v_open, '13:00'::time);
  v_close := coalesce(v_close, '22:00'::time);

  select buffer_minutes, default_slot_capacity
  into v_buffer_minutes, v_capacity
  from public.scheduling_settings where id = true;
  v_buffer_minutes := coalesce(v_buffer_minutes, 30);
  v_capacity := coalesce(v_capacity, 2);

  if p_venue_id is not null then
    select capacity into v_venue_capacity_override from public.venue_capacity where venue_id = p_venue_id;
    v_capacity := coalesce(v_venue_capacity_override, v_capacity);
  else
    select capacity into v_scope_override from public.scope_capacity where scope = p_scope;
    v_capacity := coalesce(v_scope_override, v_capacity);
  end if;

  -- Daily cap — unaffected by extensions, see count_held_extension_
  -- conflicts()'s header comment.
  if p_venue_id is not null then
    select count(*)
    into v_daily_count
    from public.reservations r
    where r.event_date = p_event_date
      and public.is_capacity_blocking_reservation_status(r.status)
      and (p_exclude_reservation_id is null or r.reservation_id <> p_exclude_reservation_id)
      and r.venue_id = p_venue_id;
    v_daily_count := coalesce(v_daily_count, 0);
  elsif p_scope is not null then
    select count(*)
    into v_daily_count
    from public.reservations r
    left join public.package rp on rp.package_id = r.package_id
    where r.event_date = p_event_date
      and public.is_capacity_blocking_reservation_status(r.status)
      and (p_exclude_reservation_id is null or r.reservation_id <> p_exclude_reservation_id)
      and p_scope = any(coalesce(r.booking_scope, array[public.normalize_booking_scope(r.location_type, rp.package_name)]));

    v_held_count := public.count_held_reschedule_conflicts(p_event_date, p_scope, p_exclude_reservation_id => p_exclude_reservation_id);

    v_daily_count := coalesce(v_daily_count, 0) + coalesce(v_held_count, 0);
  else
    v_daily_count := 0;
  end if;
  v_capacity_reached := (p_venue_id is not null or p_scope is not null) and (v_daily_count >= v_capacity);

  v_last_offset := floor(
    (extract(epoch from ((v_close - make_interval(hours => v_duration))::time - v_open)) / 60)
    / v_interval_minutes
  ) * v_interval_minutes;

  if v_last_offset < 0 then
    return;
  end if;

  return query
  with slots as (
    select (v_open + (offset_minutes || ' minutes')::interval)::time as slot_start
    from generate_series(0, v_last_offset, v_interval_minutes) as offset_minutes
  ),
  slot_status as (
    select
      s.slot_start,
      (
        case when p_venue_id is not null then (
          select count(*)
          from public.reservations r
          where r.event_date = p_event_date
            and public.is_capacity_blocking_reservation_status(r.status)
            and (p_exclude_reservation_id is null or r.reservation_id <> p_exclude_reservation_id)
            and r.venue_id = p_venue_id
            and public.booking_times_overlap(
              (s.slot_start - make_interval(mins => v_buffer_minutes))::time,
              ((s.slot_start + make_interval(hours => v_duration))::time + make_interval(mins => v_buffer_minutes))::time,
              coalesce(r.start_time, public.parse_event_time_text(r.event_time)),
              coalesce(r.event_end_time, (coalesce(r.start_time, public.parse_event_time_text(r.event_time)) + make_interval(hours => 3))::time)
            )
        ) else (
          (
            select count(*)
            from public.reservations r
            left join public.package rp on rp.package_id = r.package_id
            where r.event_date = p_event_date
              and public.is_capacity_blocking_reservation_status(r.status)
              and (p_exclude_reservation_id is null or r.reservation_id <> p_exclude_reservation_id)
              and p_scope = any(coalesce(r.booking_scope, array[public.normalize_booking_scope(r.location_type, rp.package_name)]))
              and public.booking_times_overlap(
                (s.slot_start - make_interval(mins => v_buffer_minutes))::time,
                ((s.slot_start + make_interval(hours => v_duration))::time + make_interval(mins => v_buffer_minutes))::time,
                coalesce(r.start_time, public.parse_event_time_text(r.event_time)),
                coalesce(
                  r.event_end_time,
                  (
                    coalesce(r.start_time, public.parse_event_time_text(r.event_time))
                    + make_interval(hours => coalesce(rp.duration_hours, 3))
                  )::time
                )
              )
          )
          +
          public.count_held_reschedule_conflicts(
            p_event_date, p_scope,
            s.slot_start, (s.slot_start + make_interval(hours => v_duration))::time,
            v_buffer_minutes, p_exclude_reservation_id
          )
          +
          public.count_held_extension_conflicts(
            p_event_date, p_scope,
            s.slot_start, (s.slot_start + make_interval(hours => v_duration))::time,
            v_buffer_minutes, p_exclude_reservation_id
          )
        ) end
      ) as overlap_count
    from slots s
  )
  select
    to_char(p_event_date + ss.slot_start, 'FMHH12:MI AM'),
    ss.slot_start,
    (ss.slot_start + make_interval(hours => v_duration))::time,
    ((p_venue_id is not null or p_scope is not null) and not v_capacity_reached and ss.overlap_count = 0),
    case
      when p_venue_id is null and p_scope is null then 'Select a package first.'
      when v_capacity_reached then 'This scope has reached its daily booking limit for this date.'
      when ss.overlap_count > 0 then 'Unavailable due to another reservation.'
      else null
    end
  from slot_status ss
  order by ss.slot_start;
end;
$$;

grant execute on function public.get_available_start_times(date, text, integer, uuid, uuid) to anon, authenticated;
