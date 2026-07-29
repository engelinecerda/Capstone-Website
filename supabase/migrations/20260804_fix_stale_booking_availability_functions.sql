-- Fixes a gap left by 20260801_availability_scheduling.sql: that migration
-- updated enforce_reservation_capacity/enforce_reschedule_capacity and
-- get_available_start_times (the time-slot grid) to the new per-weekday
-- operating-hours + buffer + per-scope-capacity model, but missed two
-- other functions still running the OLD flat "2+ reservations that day,
-- any scope" rule from 20260509_two_reservations_per_day.sql:
--
--   - get_booking_availability()          — drives the "This date is fully
--     booked" message and the early return that skips loading the time
--     grid entirely (js/reservation_availability.js fetchDateAvailability,
--     reservations.html ~line 1643/2360/2862).
--   - get_booking_calendar_availability() — drives which dates the month
--     calendar greys out as fully booked (fetchCalendarAvailability,
--     reservations.html ~line 1603, isFullyBooked/isDateUnavailableForScope).
--
-- Symptom this caused: a single approved reservation (or even several,
-- as long as the total that day stayed under 2) never affected either of
-- these — the day always looked wide open regardless of real per-scope
-- capacity/buffer settings, even though the actual time-slot grid
-- (get_available_start_times) was already correct.
--
-- Fix: both now delegate to get_available_start_times() — the single
-- source of truth for "can this scope/date/duration actually be booked" —
-- instead of re-implementing their own (now-stale) capacity rule. Function
-- signatures are unchanged, so no frontend edits are needed.

-- 1. get_booking_availability — "is this specific scope fully booked on
--    this date" for the requested duration. p_scope is required for a
--    meaningful answer (as before, callers always pass one from
--    getSelectedBookingScope()); null scope returns the neutral default.
create or replace function public.get_booking_availability(
  p_event_date             date,
  p_scope                  text default null,
  p_duration_hours         integer default null,
  p_exclude_reservation_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_has_available boolean;
  v_scope_taken   boolean;
begin
  if p_scope is null then
    return jsonb_build_object(
      'event_date', p_event_date,
      'occupied_scopes', '{}'::text[],
      'is_fully_booked', false,
      'scope_taken', false,
      'blocked_times', '{}'::text[]
    );
  end if;

  select bool_or(is_available) into v_has_available
  from public.get_available_start_times(p_event_date, p_scope, p_duration_hours, p_exclude_reservation_id);

  v_scope_taken := not coalesce(v_has_available, false);

  return jsonb_build_object(
    'event_date', p_event_date,
    'occupied_scopes', case when v_scope_taken then array[p_scope] else '{}'::text[] end,
    'is_fully_booked', v_scope_taken,
    'scope_taken', v_scope_taken,
    'blocked_times', '{}'::text[]
  );
end;
$$;

-- 2. get_booking_calendar_availability — per-date summary for the month
--    grid. Has no scope/duration parameter (it previews every package a
--    customer might pick), so it checks all 3 known scopes at a
--    conservative 1-hour probe duration and only marks a date fully
--    booked when every scope is exhausted — the actual booking attempt is
--    still gated correctly by the duration-aware time grid and the DB
--    trigger regardless of what this preview shows.
create or replace function public.get_booking_calendar_availability(
  p_from_date date,
  p_to_date   date
)
returns table (
  event_date      date,
  occupied_scopes text[],
  is_fully_booked boolean
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_date      date := p_from_date;
  v_scopes    text[] := array['onsite_vip', 'onsite_main_hall', 'offsite'];
  v_scope     text;
  v_occupied  text[];
  v_available boolean;
begin
  while v_date <= p_to_date loop
    v_occupied := '{}'::text[];

    foreach v_scope in array v_scopes loop
      select bool_or(is_available) into v_available
      from public.get_available_start_times(v_date, v_scope, 1, null);

      if not coalesce(v_available, false) then
        v_occupied := array_append(v_occupied, v_scope);
      end if;
    end loop;

    event_date := v_date;
    occupied_scopes := v_occupied;
    is_fully_booked := (array_length(v_occupied, 1) = 3);
    return next;

    v_date := v_date + 1;
  end loop;
end;
$$;

grant execute on function public.get_booking_availability(date, text, integer, uuid) to anon, authenticated;
grant execute on function public.get_booking_calendar_availability(date, date) to anon, authenticated;
