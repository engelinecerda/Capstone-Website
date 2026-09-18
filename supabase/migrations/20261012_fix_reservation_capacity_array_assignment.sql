-- Fix: "Reservation save failed: malformed array literal: 'onsite_vip'"
-- when submitting a booking.
--
-- Root cause: 20261010_multi_scope_packages.sql altered both package.
-- booking_scope and reservations.booking_scope from text to text[], and
-- redefined enforce_reservation_capacity() (and the other functions below)
-- to assign new.booking_scope from an array variable (v_scopes, built via
-- the array[...] constructor) instead of a plain scalar. The error's exact
-- shape only happens when a bare, unbracketed string like "onsite_vip" is
-- written into a text[] column — Postgres tries to parse it as an array's
-- text representation (which requires "{...}" braces) and fails. That is
-- exactly what the OLDER version of enforce_reservation_capacity() did
-- (`new.booking_scope := v_scope;` with v_scope as plain text, from
-- 20260706_package_explicit_booking_scope.sql / 20261006_fix_missing_
-- advance_notice_enforcement.sql), which means the column-type change from
-- 20261010 reached the live database but its accompanying function
-- redefinitions did not — most likely because that migration was run in
-- the SQL Editor as separate selections/batches and the "── 2." section
-- onward (the function bodies) was skipped or failed silently after the
-- "── 1." column/constraint/view section already committed.
--
-- Fix: re-apply ONLY the function bodies from 20261010_multi_scope_
-- packages.sql sections 2-6, verbatim, byte-for-byte identical to that
-- migration. No ALTER TABLE / constraint / view statements are repeated
-- here — those already succeeded (confirmed by the very fact that the
-- column is text[], which is what makes the mismatch observable at all)
-- and re-running them against an already-migrated column would itself
-- error. CREATE OR REPLACE FUNCTION is idempotent, so this is safe to run
-- regardless of exactly how far the original migration got.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── enforce_reservation_capacity() — array-aware ────────────────────────────
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
  -- Multi-scope: prefer the package's own explicit set; normalize_booking_
  -- scope() is a single-value fallback for a package no admin has
  -- configured yet, wrapped as a one-element set so every check below can
  -- treat "this reservation's scopes" uniformly as an array either way.
  v_scopes := coalesce(v_package_scopes, array[public.normalize_booking_scope(new.location_type, v_package_name)]);
  new.booking_scope := v_scopes;

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
  -- signature.
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

  if exists (
    select 1
    from public.reservations r
    left join public.package rp on rp.package_id = r.package_id
    where r.event_date = new.event_date
      and lower(coalesce(r.status, '')) in ('approved', 'confirmed', 'rescheduled')
      -- Array overlap (&&): true the moment the two reservations share even
      -- one scope — the only way a combo reservation can be told apart from
      -- one that only touches a single room it doesn't actually conflict on.
      and coalesce(r.booking_scope, array[public.normalize_booking_scope(r.location_type, rp.package_name)]) && v_scopes
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
  ) or v_held_conflict then
    raise exception using
      errcode = 'P0001',
      message = 'This reservation overlaps an existing booking for the selected date and scope.';
  end if;

  -- Daily capacity cap — walked once per scope in this reservation's set,
  -- since VIP and Main Hall keep their own separate daily caps even for a
  -- combo package that occupies both; it's rejected the moment either one
  -- is exhausted.
  v_event_label := to_char(new.event_date::timestamp, 'FMMonth DD, YYYY');

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

  return new;
end;
$$;

-- ── enforce_reschedule_capacity() — array-aware ─────────────────────────────
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
    foreach v_single_scope in array v_scopes loop
      v_overlap_count := v_overlap_count + public.count_held_reschedule_conflicts(
        new.requested_date, v_single_scope, v_start_time, v_end_time, v_buffer_minutes, v_reservation.reservation_id
      ) + public.count_held_extension_conflicts(
        new.requested_date, v_single_scope, v_start_time, v_end_time, v_buffer_minutes, v_reservation.reservation_id
      );
    end loop;

    if v_overlap_count > 0 then
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

    -- Daily capacity — one scope at a time, same as the insert trigger.
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

  return new;
end;
$$ language plpgsql;

-- ── count_held_reschedule_conflicts() / count_held_extension_conflicts()
--    — internal scope comparison only, signature unchanged (both still take
--    a single p_scope; callers above loop over a reservation's scope set
--    and call these once per element). ─────────────────────────────────────
create or replace function public.count_held_reschedule_conflicts(
  p_date                   date,
  p_scope                  text,
  p_slot_start             time default null,
  p_slot_end               time default null,
  p_buffer_minutes         integer default 0,
  p_exclude_reservation_id uuid default null
)
returns integer
language sql
stable
security definer
set search_path = public
as $$
  select count(*)::integer
  from public.reschedule_requests rr
  join public.reservations res on res.reservation_id = rr.reservation_id
  left join public.package resp on resp.package_id = res.package_id
  where rr.requested_date = p_date
    and rr.status = 'approved_pending_payment'
    and rr.hold_expires_at > now()
    and (p_exclude_reservation_id is null or rr.reservation_id <> p_exclude_reservation_id)
    and p_scope = any(coalesce(res.booking_scope, array[public.normalize_booking_scope(res.location_type, resp.package_name)]))
    and (
      p_slot_start is null
      or public.booking_times_overlap(
        (p_slot_start - make_interval(mins => p_buffer_minutes))::time,
        (p_slot_end + make_interval(mins => p_buffer_minutes))::time,
        public.parse_event_time_text(rr.requested_time),
        (
          public.parse_event_time_text(rr.requested_time)
          + make_interval(hours => coalesce(resp.duration_hours, 3))
        )::time
      )
    );
$$;

create or replace function public.count_held_extension_conflicts(
  p_date                   date,
  p_scope                  text,
  p_slot_start             time,
  p_slot_end               time,
  p_buffer_minutes         integer default 0,
  p_exclude_reservation_id uuid default null
)
returns integer
language sql
stable
security definer
set search_path = public
as $$
  select count(*)::integer
  from public.reservation_extensions re
  join public.reservations res on res.reservation_id = re.reservation_id
  left join public.package resp on resp.package_id = res.package_id
  where res.event_date = p_date
    and (
      re.status = 'pending_verification'
      or (re.status = 'pending_payment' and re.hold_expires_at > now())
    )
    and (p_exclude_reservation_id is null or res.reservation_id <> p_exclude_reservation_id)
    and p_scope = any(coalesce(res.booking_scope, array[public.normalize_booking_scope(res.location_type, resp.package_name)]))
    and p_slot_start is not null
    and public.booking_times_overlap(
      (p_slot_start - make_interval(mins => p_buffer_minutes))::time,
      (p_slot_end + make_interval(mins => p_buffer_minutes))::time,
      coalesce(res.event_end_time, public.parse_event_time_text(res.event_time)),
      (
        coalesce(res.event_end_time, public.parse_event_time_text(res.event_time))
        + make_interval(secs => re.requested_hours * 3600)
      )::time
    );
$$;

-- ── get_available_start_times() — internal scope comparison only,
--    signature unchanged (still takes a single p_scope). ────────────────────
create or replace function public.get_available_start_times(
  p_event_date             date,
  p_scope                  text,
  p_duration_hours         integer,
  p_exclude_reservation_id uuid default null
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

  select capacity into v_scope_override from public.scope_capacity where scope = p_scope;
  v_capacity := coalesce(v_scope_override, v_capacity);

  -- Daily cap — unaffected by extensions, see count_held_extension_
  -- conflicts()'s header comment.
  if p_scope is not null then
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
  v_capacity_reached := (p_scope is not null) and (v_daily_count >= v_capacity);

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
      ) as overlap_count
    from slots s
  )
  select
    to_char(p_event_date + ss.slot_start, 'FMHH12:MI AM'),
    ss.slot_start,
    (ss.slot_start + make_interval(hours => v_duration))::time,
    (p_scope is not null and not v_capacity_reached and ss.overlap_count = 0),
    case
      when p_scope is null then 'Select a package first.'
      when v_capacity_reached then 'This scope has reached its daily booking limit for this date.'
      when ss.overlap_count > 0 then 'Unavailable due to another reservation.'
      else null
    end
  from slot_status ss
  order by ss.slot_start;
end;
$$;

-- ── get_extension_availability() / finalize_extension_on_fee_approval()
--    — array-aware. ──────────────────────────────────────────────────────
create or replace function public.get_extension_availability(p_reservation_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_reservation    public.reservations%rowtype;
  v_package_name   text;
  v_package_scopes text[];
  v_extension_price numeric;
  v_scopes         text[];
  v_current_end    time;
  v_weekday        integer;
  v_close          time;
  v_buffer_minutes integer := 30;
  v_next_start     time;
  v_next_label     text;
  v_gap_minutes    numeric;
  v_gap_hours      numeric;
begin
  select * into v_reservation from public.reservations where reservation_id = p_reservation_id;
  if v_reservation.reservation_id is null then
    return jsonb_build_object('max_hours', 0, 'price_per_hour', null, 'extendable', false, 'next_booking_label', null);
  end if;

  select p.package_name, p.booking_scope, p.extension_price
  into v_package_name, v_package_scopes, v_extension_price
  from public.package p
  where p.package_id = v_reservation.package_id;

  v_scopes := coalesce(v_reservation.booking_scope, v_package_scopes, array[public.normalize_booking_scope(v_reservation.location_type, v_package_name)]);
  v_current_end := coalesce(v_reservation.event_end_time, public.parse_event_time_text(v_reservation.event_time));

  if v_extension_price is null or v_current_end is null or v_scopes is null or array_length(v_scopes, 1) is null
     or not public.is_capacity_blocking_reservation_status(v_reservation.status) then
    return jsonb_build_object('max_hours', 0, 'price_per_hour', v_extension_price, 'extendable', false, 'next_booking_label', null);
  end if;

  select buffer_minutes into v_buffer_minutes from public.scheduling_settings where id = true;
  v_buffer_minutes := coalesce(v_buffer_minutes, 30);

  v_weekday := extract(dow from v_reservation.event_date);
  select close_time into v_close from public.operating_hours where weekday = v_weekday;
  v_close := coalesce(v_close, '22:00'::time);

  select candidates.next_start, candidates.label
  into v_next_start, v_next_label
  from (
    select public.parse_event_time_text(r.event_time) as next_start,
           to_char(v_reservation.event_date + public.parse_event_time_text(r.event_time), 'FMHH12:MI AM') as label
    from public.reservations r
    left join public.package rp on rp.package_id = r.package_id
    where r.event_date = v_reservation.event_date
      and r.reservation_id <> v_reservation.reservation_id
      and public.is_capacity_blocking_reservation_status(r.status)
      and coalesce(r.booking_scope, array[public.normalize_booking_scope(r.location_type, rp.package_name)]) && v_scopes
      and public.parse_event_time_text(r.event_time) > v_current_end

    union all

    select public.parse_event_time_text(rr.requested_time) as next_start,
           to_char(v_reservation.event_date + public.parse_event_time_text(rr.requested_time), 'FMHH12:MI AM') as label
    from public.reschedule_requests rr
    join public.reservations rres on rres.reservation_id = rr.reservation_id
    left join public.package rrp on rrp.package_id = rres.package_id
    where rr.requested_date = v_reservation.event_date
      and rr.status = 'approved_pending_payment'
      and rr.hold_expires_at > now()
      and coalesce(rres.booking_scope, array[public.normalize_booking_scope(rres.location_type, rrp.package_name)]) && v_scopes
      and public.parse_event_time_text(rr.requested_time) > v_current_end
  ) candidates
  order by candidates.next_start
  limit 1;

  if v_next_start is not null then
    v_next_start := (v_next_start - make_interval(mins => v_buffer_minutes))::time;
    if v_next_start < v_close then
      v_close := v_next_start;
    end if;
  end if;

  v_gap_minutes := extract(epoch from (v_close - v_current_end)) / 60;
  v_gap_hours := greatest(floor(coalesce(v_gap_minutes, 0) / 60), 0);

  return jsonb_build_object(
    'max_hours', v_gap_hours,
    'price_per_hour', v_extension_price,
    'extendable', v_gap_hours > 0,
    'next_booking_label', case when v_next_label is not null and v_gap_minutes > 0 and v_next_start is not null then v_next_label else null end
  );
end;
$$;

create or replace function public.finalize_extension_on_fee_approval()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_extension    public.reservation_extensions%rowtype;
  v_reservation  public.reservations%rowtype;
  v_package_name text;
  v_package_scopes text[];
  v_scopes       text[];
  v_new_end      time;
  v_conflict     boolean;
begin
  if new.payment_type is distinct from 'extension_fee' or new.extension_id is null then
    return new;
  end if;
  if old.payment_status is not distinct from new.payment_status then
    return new;
  end if;
  if lower(coalesce(new.payment_status, '')) not in ('approved', 'rejected') then
    return new;
  end if;

  select * into v_extension
  from public.reservation_extensions
  where extension_id = new.extension_id
    and status = 'pending_verification';

  if v_extension.extension_id is null then
    return new;
  end if;

  select * into v_reservation from public.reservations where reservation_id = v_extension.reservation_id;

  if lower(new.payment_status) = 'rejected' then
    update public.reservation_extensions
    set status = 'rejected',
        decided_at = now(),
        decided_by = auth.uid(),
        rejection_reason = new.rejection_reason
    where extension_id = v_extension.extension_id;

    if v_reservation.user_id is not null then
      insert into public.notifications (user_id, type, title, body, link)
      values (
        v_reservation.user_id,
        'reservation_status',
        'Extension Request Rejected',
        coalesce('Your extension request was rejected: ' || new.rejection_reason, 'Your extension request was rejected.'),
        '/reservation-details.html?reservation_id=' || v_reservation.reservation_id
      );
    end if;

    return new;
  end if;

  -- Approval: re-check for a conflict that may have appeared since the
  -- request was made (spec item 5's "final safety check").
  select p.package_name, p.booking_scope into v_package_name, v_package_scopes from public.package p where p.package_id = v_reservation.package_id;
  v_scopes := coalesce(v_reservation.booking_scope, v_package_scopes, array[public.normalize_booking_scope(v_reservation.location_type, v_package_name)]);
  v_new_end := (coalesce(v_reservation.event_end_time, public.parse_event_time_text(v_reservation.event_time)) + make_interval(secs => v_extension.requested_hours * 3600))::time;

  select exists (
    select 1
    from public.reservations r
    left join public.package rp on rp.package_id = r.package_id
    where r.event_date = v_reservation.event_date
      and r.reservation_id <> v_reservation.reservation_id
      and public.is_capacity_blocking_reservation_status(r.status)
      and coalesce(r.booking_scope, array[public.normalize_booking_scope(r.location_type, rp.package_name)]) && v_scopes
      and public.booking_times_overlap(
        coalesce(v_reservation.event_end_time, public.parse_event_time_text(v_reservation.event_time)),
        v_new_end,
        public.parse_event_time_text(r.event_time),
        coalesce(r.event_end_time, (public.parse_event_time_text(r.event_time) + make_interval(hours => coalesce(rp.duration_hours, 3)))::time)
      )
  ) into v_conflict;

  if v_conflict then
    raise exception using
      errcode = 'P0001',
      message = 'This extension can no longer be approved — another booking now overlaps the requested time. Reject this request instead so the customer can be notified.';
  end if;

  update public.reservation_extensions
  set status = 'approved', decided_at = now(), decided_by = auth.uid()
  where extension_id = v_extension.extension_id;

  update public.reservations
  set event_end_time = v_new_end
  where reservation_id = v_reservation.reservation_id;

  if v_reservation.user_id is not null then
    insert into public.notifications (user_id, type, title, body, link)
    values (
      v_reservation.user_id,
      'reservation_status',
      'Extension Approved',
      'Your ' || v_extension.requested_hours || '-hour extension was approved. Your event now ends at ' || to_char(v_reservation.event_date + v_new_end, 'FMHH12:MI AM') || '.',
      '/reservation-details.html?reservation_id=' || v_reservation.reservation_id
    );
  end if;

  return new;
end;
$$;
