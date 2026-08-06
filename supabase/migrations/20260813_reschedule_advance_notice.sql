-- Reschedule requests had no advance-notice enforcement at all — neither
-- client-side nor in enforce_reschedule_capacity() — unlike new bookings,
-- which at least get a client-side check in reservations.html. A customer
-- could request a reschedule to a date inside the configured minimum
-- notice window (system_settings.reservation_rules / event_types.
-- min_advance_days), or beyond the maximum booking horizon, and nothing
-- would stop it.
--
-- js/account.js's reschedule modal now checks this client-side (see
-- js/reservation_availability.js's loadAdvanceNoticeRules/
-- isOutsideBookingWindow), but per this project's RLS/DB-first enforcement
-- philosophy (see 20260803_last_admin_guard.sql), the real backstop
-- belongs here, in the trigger — the client-side check is just the
-- friendlier pre-flight.

create or replace function public.enforce_reschedule_capacity()
returns trigger
language plpgsql
as $$
declare
  v_reservation         public.reservations%rowtype;
  v_package_name        text;
  v_duration_hours      integer := 3;
  v_scope               text;
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

  -- Advance-notice window: minimum days from today (with a per-event-type
  -- override taking priority over the site-wide default) and maximum days
  -- from today. Mirrors js/reservation_availability.js's
  -- getEffectiveMinAdvanceDays/isOutsideBookingWindow exactly.
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
