-- ═══════════════════════════════════════════════════════════════════════════
-- Time grid offered start times the booking guard then refused
--
-- Symptom: a customer picked a date and start time the grid showed as open,
-- signed the contract, and on submit got "That date or time was just taken by
-- another booking" — for a date that already had its approved bookings.
--
-- Root cause: when a room (venue) is resolved for the booking, the time grid
-- (get_available_start_times) only looked at reservations stored against that
-- SAME venue_id, and left out held reschedule / extension windows. The guard
-- on insert (enforce_reservation_capacity, 20261026) is wider:
--   1. A reservation with NO venue_id (a combo package, or one booked before
--      rooms existed) is treated as occupying its whole scope, so it
--      conflicts with every room in that scope.
--   2. Held reschedule and approved-extension windows are checked per scope.
-- Anything in those two groups was invisible to the grid, so those slots
-- looked open, and the database then (correctly) rejected the insert. The
-- check right before submit calls this same function, so it could not catch
-- it either.
--
-- Fix: the room branch of the overlap count now includes both. Nothing else
-- changes: signature, return shape, buffer, daily cap and the scope branch
-- are the 20261112 definition verbatim. The trigger is untouched; the grid is
-- brought in line with it. Safe to re-run.
--
-- Check which case a date is in (replace the date):
--   select reservation_number, status, venue_id, booking_scope, event_time
--   from public.reservations
--   where event_date = '2026-11-25'
--   order by event_time;
-- Rows with a null venue_id on the booked scope are case 1.
-- ═══════════════════════════════════════════════════════════════════════════

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
          -- Same rule enforce_reservation_capacity() applies: a booking
          -- with a room only conflicts when it is the SAME room, but a
          -- booking with NO room recorded (a combo package, or one made
          -- before rooms existed) occupies its whole scope, so it
          -- conflicts with every room in that scope.
          (
            select count(*)
            from public.reservations r
            left join public.package rp on rp.package_id = r.package_id
            where r.event_date = p_event_date
              and public.is_capacity_blocking_reservation_status(r.status)
              and (p_exclude_reservation_id is null or r.reservation_id <> p_exclude_reservation_id)
              and (
                r.venue_id = p_venue_id
                or (
                  r.venue_id is null
                  and p_scope is not null
                  and p_scope = any(coalesce(r.booking_scope, array[public.normalize_booking_scope(r.location_type, rp.package_name)]))
                )
              )
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
          -- Held reschedule / approved extension windows are checked by
          -- the trigger per scope whether or not a room is resolved, so
          -- the room-aware grid has to count them too.
          + case when p_scope is not null then (
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
          ) else 0 end
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
