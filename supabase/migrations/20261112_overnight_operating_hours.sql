-- ═══════════════════════════════════════════════════════════════════════════
-- Operating hours that close after midnight (e.g. 12:00 pm -> 12:00 am)
--
-- Until now an open day had to close later than it opened on the same clock
-- day (the hours_when_open CHECK), so a venue open noon to midnight could not
-- be saved. A closing time at or before the opening time now means "closes
-- after midnight".
--
-- Three things depended on the old rule and are updated together:
--   1. operating_hours.hours_when_open        — no longer demands open < close.
--   2. booking_times_overlap()                — an end time at or before its
--      start (an event ending at 12:00 am wraps to 00:00) is treated as ending
--      on the next day. Without this a 9 PM–12 AM booking would not conflict
--      with anything, i.e. double bookings could slip through. Every capacity /
--      reschedule / extension overlap check goes through this one function.
--   3. get_available_start_times() and get_extension_availability() — measure
--      the opening window / remaining gap across midnight. Behaviour for
--      ordinary same-day hours (e.g. 1:00 PM – 10:00 PM) is unchanged.
--
-- Start times offered to customers always stay on the event date itself.
-- ═══════════════════════════════════════════════════════════════════════════

-- 1. Any open/close pair is allowed; an open day still needs both times.
alter table public.operating_hours drop constraint if exists hours_when_open;
alter table public.operating_hours
  add constraint hours_when_open check (
    not is_open or (open_time is not null and close_time is not null)
  );

-- 2. Overlap test that understands a range ending at/after midnight.
create or replace function public.booking_times_overlap(
  p_start_a time,
  p_end_a time,
  p_start_b time,
  p_end_b time
)
returns boolean
language sql
immutable
as $$
  select
    p_start_a is not null
    and p_end_a is not null
    and p_start_b is not null
    and p_end_b is not null
    and extract(epoch from p_start_a)
        < extract(epoch from p_end_b) + case when p_end_b <= p_start_b then 86400 else 0 end
    and extract(epoch from p_end_a) + case when p_end_a <= p_start_a then 86400 else 0 end
        > extract(epoch from p_start_b)
$$;

-- 3a. Start times (latest definition: 20261016_venue_capacity_and_selection.sql).
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

  -- Opening window in minutes. A closing time at or before the opening time
  -- (e.g. 12:00 pm -> 12:00 am) means the venue closes after midnight, so the
  -- window runs into the next day. The last start time must still leave room
  -- for the full package duration, and every start time stays on the event
  -- date itself (nothing is offered from midnight onward).
  v_last_offset := floor(
    (
      (case
         when v_close > v_open then extract(epoch from (v_close - v_open)) / 60
         else extract(epoch from (v_close - v_open)) / 60 + 1440
       end) - v_duration * 60
    ) / v_interval_minutes
  ) * v_interval_minutes;
  v_last_offset := least(
    v_last_offset,
    floor((1439 - extract(epoch from v_open) / 60) / v_interval_minutes) * v_interval_minutes
  );

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

-- 3b. Extension availability (latest definition: 20261012_fix_reservation_capacity_array_assignment.sql).
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
  v_open           time;
  v_close          time;
  v_close_abs      numeric;
  v_end_abs        numeric;
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
  select open_time, close_time into v_open, v_close from public.operating_hours where weekday = v_weekday;
  v_open  := coalesce(v_open, '13:00'::time);
  v_close := coalesce(v_close, '22:00'::time);

  -- Work in minutes since the event date's midnight. A closing time at or
  -- before the opening time (e.g. 12:00 am) closes after midnight, and a
  -- reservation whose end time is at or before its start time (e.g. ends at
  -- 12:00 am) ends after midnight; both are pushed onto the next day.
  v_close_abs := extract(epoch from v_close) / 60;
  if v_close <= v_open then
    v_close_abs := v_close_abs + 1440;
  end if;
  v_end_abs := extract(epoch from v_current_end) / 60;
  if v_current_end <= coalesce(v_reservation.start_time, public.parse_event_time_text(v_reservation.event_time)) then
    v_end_abs := v_end_abs + 1440;
  end if;

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
    if extract(epoch from v_next_start) / 60 < v_close_abs then
      v_close_abs := extract(epoch from v_next_start) / 60;
    end if;
  end if;

  v_gap_minutes := v_close_abs - v_end_abs;
  v_gap_hours := greatest(floor(coalesce(v_gap_minutes, 0) / 60), 0);

  return jsonb_build_object(
    'max_hours', v_gap_hours,
    'price_per_hour', v_extension_price,
    'extendable', v_gap_hours > 0,
    'next_booking_label', case when v_next_label is not null and v_gap_minutes > 0 and v_next_start is not null then v_next_label else null end
  );
end;
$$;
