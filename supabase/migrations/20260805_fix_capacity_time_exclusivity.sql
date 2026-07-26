-- Fixes a design flaw in 20260801_availability_scheduling.sql: "capacity"
-- let up to N *overlapping* bookings share the same scope/time, which
-- doesn't reflect reality — a scope is a single room/venue, so two
-- different customers can't both hold it 2–5 PM just because capacity
-- says 2. Confirmed with the user: once a time is approved for a scope,
-- it must always be excluded for anyone else, regardless of capacity —
-- only a reschedule or cancellation frees it back up.
--
-- New model, two independent rules per scope:
--   1. Time-slot exclusivity (hard, not configurable): any buffer-padded
--      overlap with an existing active same-scope reservation always
--      blocks — capacity plays no part in this check anymore.
--   2. Daily capacity (what "capacity" now means): how many separate,
--      non-overlapping bookings that scope may hold across the whole day.
--      Since rule 1 already guarantees same-scope bookings on one day
--      never overlap, this is just a count of existing same-scope active
--      reservations that date vs. the resolved capacity.
--
-- Buffer, per-scope overrides, and operating hours are unchanged.

-- ═══════════════════════════════════════════════════════════════════════════
-- 1. enforce_reservation_capacity
-- ═══════════════════════════════════════════════════════════════════════════
create or replace function public.enforce_reservation_capacity()
returns trigger
language plpgsql
as $$
declare
  v_package_name    text;
  v_duration_hours  integer := 3;
  v_scope           text;
  v_start_time      time;
  v_end_time        time;
  v_weekday         integer;
  v_is_open         boolean;
  v_weekday_label   text;
  v_buffer_minutes  integer := 30;
  v_capacity        integer := 2;
  v_scope_override  integer;
  v_padded_start    time;
  v_padded_end      time;
  v_overlap_count   integer;
  v_daily_count     integer;
  v_scope_label     text;
begin
  select p.package_name, coalesce(p.duration_hours, 3)
  into   v_package_name, v_duration_hours
  from   public.package p
  where  p.package_id = new.package_id;

  v_scope            := public.normalize_booking_scope(new.location_type, v_package_name);
  new.booking_scope  := v_scope;
  new.duration_hours := v_duration_hours;

  v_start_time  := public.parse_event_time_text(new.event_time);
  new.start_time := v_start_time;

  if v_start_time is not null and coalesce(v_duration_hours, 0) > 0 then
    v_end_time := (v_start_time + make_interval(hours => v_duration_hours))::time;
  else
    v_end_time := null;
  end if;
  new.event_end_time := v_end_time;

  if not public.is_capacity_blocking_reservation_status(new.status) then
    return new;
  end if;

  if new.event_date is null then
    return new;
  end if;

  -- Closed weekday.
  v_weekday := extract(dow from new.event_date);
  select is_open into v_is_open from public.operating_hours where weekday = v_weekday;
  if coalesce(v_is_open, true) is false then
    v_weekday_label := trim(to_char(new.event_date::timestamp, 'FMDay'));
    raise exception using
      errcode = 'P0001',
      message = 'The café is closed on ' || v_weekday_label || 's — please choose a different date.';
  end if;

  if v_scope is not null and v_start_time is not null and v_end_time is not null then
    select buffer_minutes, default_slot_capacity
    into v_buffer_minutes, v_capacity
    from public.scheduling_settings where id = true;
    v_buffer_minutes := coalesce(v_buffer_minutes, 30);
    v_capacity := coalesce(v_capacity, 2);

    select capacity into v_scope_override from public.scope_capacity where scope = v_scope;
    v_capacity := coalesce(v_scope_override, v_capacity);

    v_padded_start := (v_start_time - make_interval(mins => v_buffer_minutes))::time;
    v_padded_end   := (v_end_time   + make_interval(mins => v_buffer_minutes))::time;

    v_scope_label := case v_scope
      when 'onsite_vip' then 'VIP'
      when 'onsite_main_hall' then 'Main Hall'
      when 'offsite' then 'Off-site'
      else 'Selected'
    end;

    -- Rule 1 — hard time-slot exclusivity, capacity plays no part.
    select count(*)
    into v_overlap_count
    from public.reservations r
    left join public.package rp on rp.package_id = r.package_id
    where r.event_date = new.event_date
      and public.is_capacity_blocking_reservation_status(r.status)
      and r.reservation_id <> coalesce(new.reservation_id, '00000000-0000-0000-0000-000000000000'::uuid)
      and coalesce(r.booking_scope, public.normalize_booking_scope(r.location_type, rp.package_name)) = v_scope
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

    if v_overlap_count > 0 then
      raise exception using
        errcode = 'P0001',
        message = v_scope_label || ' is already booked at that time.';
    end if;

    -- Rule 2 — daily cap: how many separate bookings this scope may hold
    -- across the whole day (these are guaranteed non-overlapping by rule 1).
    select count(*)
    into v_daily_count
    from public.reservations r
    left join public.package rp on rp.package_id = r.package_id
    where r.event_date = new.event_date
      and public.is_capacity_blocking_reservation_status(r.status)
      and r.reservation_id <> coalesce(new.reservation_id, '00000000-0000-0000-0000-000000000000'::uuid)
      and coalesce(r.booking_scope, public.normalize_booking_scope(r.location_type, rp.package_name)) = v_scope;

    if v_daily_count >= v_capacity then
      raise exception using
        errcode = 'P0001',
        message = v_scope_label || ' has reached its daily booking limit for this date.';
    end if;
  end if;

  return new;
end;
$$;

-- ═══════════════════════════════════════════════════════════════════════════
-- 2. enforce_reschedule_capacity — mirrors the same two rules.
-- ═══════════════════════════════════════════════════════════════════════════
create or replace function public.enforce_reschedule_capacity()
returns trigger
language plpgsql
as $$
declare
  v_reservation    public.reservations%rowtype;
  v_package_name   text;
  v_duration_hours integer := 3;
  v_scope          text;
  v_start_time     time;
  v_end_time       time;
  v_weekday        integer;
  v_is_open        boolean;
  v_weekday_label  text;
  v_buffer_minutes integer := 30;
  v_capacity       integer := 2;
  v_scope_override integer;
  v_padded_start   time;
  v_padded_end     time;
  v_overlap_count  integer;
  v_daily_count    integer;
  v_scope_label    text;
begin
  if lower(coalesce(new.status, 'pending')) in ('rejected', 'completed') then
    return new;
  end if;

  select r.*
  into   v_reservation
  from   public.reservations r
  where  r.reservation_id = new.reservation_id;

  if v_reservation.reservation_id is null then
    return new;
  end if;

  select p.package_name, coalesce(p.duration_hours, 3)
  into   v_package_name, v_duration_hours
  from   public.package p
  where  p.package_id = v_reservation.package_id;

  v_scope      := public.normalize_booking_scope(v_reservation.location_type, v_package_name);
  v_start_time := public.parse_event_time_text(new.requested_time);

  if v_start_time is not null and coalesce(v_duration_hours, 0) > 0 then
    v_end_time := (v_start_time + make_interval(hours => v_duration_hours))::time;
  else
    v_end_time := null;
  end if;

  if new.requested_date is null then
    return new;
  end if;

  v_weekday := extract(dow from new.requested_date);
  select is_open into v_is_open from public.operating_hours where weekday = v_weekday;
  if coalesce(v_is_open, true) is false then
    v_weekday_label := trim(to_char(new.requested_date::timestamp, 'FMDay'));
    raise exception using
      errcode = 'P0001',
      message = 'The café is closed on ' || v_weekday_label || 's — please choose a different date.';
  end if;

  if v_scope is not null and v_start_time is not null and v_end_time is not null then
    select buffer_minutes, default_slot_capacity
    into v_buffer_minutes, v_capacity
    from public.scheduling_settings where id = true;
    v_buffer_minutes := coalesce(v_buffer_minutes, 30);
    v_capacity := coalesce(v_capacity, 2);

    select capacity into v_scope_override from public.scope_capacity where scope = v_scope;
    v_capacity := coalesce(v_scope_override, v_capacity);

    v_padded_start := (v_start_time - make_interval(mins => v_buffer_minutes))::time;
    v_padded_end   := (v_end_time   + make_interval(mins => v_buffer_minutes))::time;

    v_scope_label := case v_scope
      when 'onsite_vip' then 'VIP'
      when 'onsite_main_hall' then 'Main Hall'
      when 'offsite' then 'Off-site'
      else 'Selected'
    end;

    select count(*)
    into v_overlap_count
    from public.reservations r
    left join public.package rp on rp.package_id = r.package_id
    where r.event_date = new.requested_date
      and public.is_capacity_blocking_reservation_status(r.status)
      and r.reservation_id <> v_reservation.reservation_id
      and coalesce(r.booking_scope, public.normalize_booking_scope(r.location_type, rp.package_name)) = v_scope
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

    if v_overlap_count > 0 then
      raise exception using
        errcode = 'P0001',
        message = v_scope_label || ' is already booked at that time.';
    end if;

    select count(*)
    into v_daily_count
    from public.reservations r
    left join public.package rp on rp.package_id = r.package_id
    where r.event_date = new.requested_date
      and public.is_capacity_blocking_reservation_status(r.status)
      and r.reservation_id <> v_reservation.reservation_id
      and coalesce(r.booking_scope, public.normalize_booking_scope(r.location_type, rp.package_name)) = v_scope;

    if v_daily_count >= v_capacity then
      raise exception using
        errcode = 'P0001',
        message = v_scope_label || ' has reached its daily booking limit for this date.';
    end if;
  end if;

  return new;
end;
$$;

-- ═══════════════════════════════════════════════════════════════════════════
-- 3. get_available_start_times — same two rules: any slot overlapping an
--    existing same-scope booking (buffer-padded) is always unavailable;
--    separately, once the scope's daily count reaches capacity, every slot
--    that date is unavailable regardless of overlap.
-- ═══════════════════════════════════════════════════════════════════════════
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

  -- Daily cap — how many separate bookings this scope already holds today,
  -- independent of the per-slot overlap check below.
  if p_scope is not null then
    select count(*)
    into v_daily_count
    from public.reservations r
    left join public.package rp on rp.package_id = r.package_id
    where r.event_date = p_event_date
      and public.is_capacity_blocking_reservation_status(r.status)
      and (p_exclude_reservation_id is null or r.reservation_id <> p_exclude_reservation_id)
      and coalesce(r.booking_scope, public.normalize_booking_scope(r.location_type, rp.package_name)) = p_scope;
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
        select count(*)
        from public.reservations r
        left join public.package rp on rp.package_id = r.package_id
        where r.event_date = p_event_date
          and public.is_capacity_blocking_reservation_status(r.status)
          and (p_exclude_reservation_id is null or r.reservation_id <> p_exclude_reservation_id)
          and coalesce(r.booking_scope, public.normalize_booking_scope(r.location_type, rp.package_name)) = p_scope
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

grant execute on function public.get_available_start_times(date, text, integer, uuid) to anon, authenticated;
