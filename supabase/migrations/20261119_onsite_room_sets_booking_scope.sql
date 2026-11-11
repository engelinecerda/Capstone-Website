-- ═══════════════════════════════════════════════════════════════════════════
-- An onsite booking's room decides its scope
--
-- Symptom: ELI-261127-001 is an onsite booking in the VIP Lounge, 4:30-8:30 PM,
-- yet the VIP reschedule calendar and time list treated that time as free, and
-- the booking form and the reschedule screen disagreed about Nov 27.
--
-- Cause: "All-Occasion Party Package - Standard 50 Pax" is listed for both
-- onsite and offsite, is mapped to VIP Lounge and Main Hall, and carries the
-- offsite scope. A package-level scope cannot say which room an onsite booking
-- uses, so that booking was stored as ["offsite"] even though it holds the VIP
-- Lounge. Checks by room saw it; checks by scope (rescheduling, bookings with
-- no room, the calendar preview) did not.
--
-- Fix:
--   1. venue.booking_scope — which scope each room belongs to; backfilled for
--      the two known rooms by name. Set it for any room added later.
--   2. enforce_reservation_capacity(): an onsite booking with a resolved room
--      takes that room's scope; a room is no longer picked up for an offsite
--      booking.
--   3. enforce_reschedule_capacity(): checks against the scope saved on the
--      reservation before falling back to the package's.
--   4. Existing onsite bookings that hold a room are re-scoped to it. The
--      capacity trigger is switched off only for that one update, so old rows
--      are not re-validated, and switched back on straight after.
--
-- Both trigger functions keep their 20261115 security-definer settings (they
-- are re-applied at the end — CREATE OR REPLACE would otherwise reset them).
-- Safe to re-run.
-- ═══════════════════════════════════════════════════════════════════════════

alter table public.venue
  add column if not exists booking_scope text;

alter table public.venue drop constraint if exists venue_booking_scope_check;
alter table public.venue
  add constraint venue_booking_scope_check
  check (booking_scope is null or booking_scope in ('onsite_vip', 'onsite_main_hall'));

update public.venue
set booking_scope = case
  when lower(name) like '%vip%'       then 'onsite_vip'
  when lower(name) like '%main hall%' then 'onsite_main_hall'
end
where booking_scope is null
  and (lower(name) like '%vip%' or lower(name) like '%main hall%');

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
  v_approved_post_booking_heads integer := 0;
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
  v_combo_capacity integer;
  v_room_scope text;
begin
  select p.package_name, p.location_type, p.booking_scope, coalesce(p.duration_hours, 3), p.price, p.min_guests, p.max_guests, p.is_active
  into v_package_name, v_package_location_type, v_package_scopes, v_duration_hours, v_package_price, v_package_min_guests, v_package_max_guests, v_package_is_active
  from public.package p
  where p.package_id = new.package_id;

  -- Additional Per-Head (post-booking): self-heal additional_heads from
  -- base_additional_heads + every APPROVED post-booking request, before
  -- anything downstream reads it. base_additional_heads itself is only
  -- ever set at true INSERT (from whatever the client submitted at
  -- booking) and never touched again afterward.
  if tg_op = 'INSERT' then
    new.base_additional_heads := coalesce(new.additional_heads, 0);
  end if;

  if new.reservation_id is not null then
    select coalesce(sum(rah.requested_heads), 0)
    into v_approved_post_booking_heads
    from public.reservation_additional_head_requests rah
    where rah.reservation_id = new.reservation_id
      and rah.status = 'approved';
  else
    v_approved_post_booking_heads := 0;
  end if;
  new.additional_heads := coalesce(new.base_additional_heads, 0) + v_approved_post_booking_heads;

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
  -- A room is only ever resolved for an onsite booking: an offsite booking of a
  -- package that also lists rooms must not pick one up.
  if v_scopes is not null and array_length(v_scopes, 1) = 1 and new.location_type is distinct from 'offsite' then
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

  -- Where an onsite booking physically is decides which scope it occupies. A
  -- package listed for both onsite and offsite (e.g. All-Occasion Standard 50
  -- Pax, which carries the offsite scope) is booked into VIP Lounge or Main
  -- Hall, and every scope-based check (the calendar, rescheduling, bookings
  -- with no room) has to see it there, not as an offsite event.
  if new.location_type = 'onsite' and v_venue_id is not null then
    select v.booking_scope into v_room_scope
    from public.venue v
    where v.venue_id = v_venue_id;

    if v_room_scope is not null then
      v_scopes := array[v_room_scope];
      new.booking_scope := v_scopes;
    end if;
  end if;

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

      -- Onsite: total guests must fit the venue. A single-room package is
      -- checked against its resolved room. A combo package (2+ scopes —
      -- never gets a venue_id, since it occupies several rooms at once) is
      -- checked against the COMBINED capacity of every active room mapped
      -- to it. Anything still unresolved, or a combo with no mapped room
      -- capacity to size against, fails closed here rather than booking an
      -- unchecked headcount.
      if new.location_type = 'onsite' then
        if v_venue_id is null and coalesce(array_length(v_scopes, 1), 0) > 1 then
          select sum(v.capacity) into v_combo_capacity
          from public.package_venue pv
          join public.venue v on v.venue_id = pv.venue_id and v.is_active
          where pv.package_id = new.package_id
            and v.capacity is not null;

          if v_combo_capacity is null then
            raise exception using errcode = 'P0001',
              message = 'Could not verify venue capacity for additional guests — this package has no rooms with a set capacity.';
          end if;

          if new.guest_count > v_combo_capacity then
            raise exception using errcode = 'P0001',
              message = format('This package holds %s guests across its rooms — you can add at most %s additional guest(s).',
                v_combo_capacity,
                greatest(v_combo_capacity - coalesce(v_package_max_guests, 0), 0));
          end if;
        else
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
      end if;
      -- Offsite: no venue, no capacity check — per spec, capped only by
      -- max_additional_heads (already enforced above).

      -- Frozen at booking time — only (re)snapshotted on a true INSERT or a
      -- genuine change to the INITIAL booking-time count, never on an
      -- update that only moved the cumulative total via an approved
      -- post-booking request (see this section's own header note).
      if tg_op = 'INSERT' or new.base_additional_heads is distinct from old.base_additional_heads then
        new.additional_head_price  := v_price_per_additional_head;
        new.additional_head_charge := coalesce(new.base_additional_heads, 0) * v_price_per_additional_head;
      end if;
    else
      new.base_additional_heads  := 0;
      new.additional_head_price  := null;
      new.additional_head_charge := 0;
    end if;

    -- Extends the price-floor check above with the additional-head charge —
    -- same floor, one more term, same catering exemption (no single
    -- package.price to floor a cart-priced booking against). Always uses
    -- the frozen INITIAL charge (never the cumulative one), matching how
    -- total_price itself is never touched by an approved post-booking
    -- request.
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

  -- The scope saved on the reservation (it follows the room for onsite bookings)
  -- comes first, so a reschedule is checked where the booking really is.
  v_scopes     := coalesce(v_reservation.booking_scope, v_package_scopes, array[public.normalize_booking_scope(v_reservation.location_type, v_package_name)]);
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

alter function public.enforce_reservation_capacity() security definer set search_path = public;
alter function public.enforce_reschedule_capacity()  security definer set search_path = public;

-- Re-scope existing onsite bookings to the room they hold.
alter table public.reservations disable trigger reservations_enforce_capacity;

update public.reservations r
set booking_scope = array[v.booking_scope]
from public.venue v
where r.venue_id = v.venue_id
  and r.location_type = 'onsite'
  and v.booking_scope is not null
  and r.booking_scope is distinct from array[v.booking_scope];

alter table public.reservations enable trigger reservations_enforce_capacity;

-- ── Verify after applying ──────────────────────────────────────────────────
--   select name, booking_scope from public.venue;               -- both rooms set
--   select reservation_number, booking_scope, venue_id
--   from public.reservations where event_date = '2026-11-27';   -- 001 is now onsite_vip
--   select tgname, tgenabled from pg_trigger
--   where tgname = 'reservations_enforce_capacity';             -- tgenabled = 'O'
