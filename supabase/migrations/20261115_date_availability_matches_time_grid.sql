-- ═══════════════════════════════════════════════════════════════════════════
-- Double-booking guard + date calendar that agrees with the time grid
--
-- Two symptoms, traced to the same area:
--
--   A. A pending reservation existed on top of an approved one (same date,
--      same room, same time). The capacity triggers are meant to refuse that.
--   B. The customer calendar showed a date as open and let it be clicked,
--      but every start time on it was disabled.
--
-- ── A. Root cause: the capacity triggers could not see other customers ─────
-- enforce_reservation_capacity() (reservations) and
-- enforce_reschedule_capacity() (reschedule_requests) were created without
-- SECURITY DEFINER, so they run with the privileges of whoever fires them.
-- When a customer inserts a booking, row-level security on public.reservations
-- ("select own reservations": auth.uid() = user_id) hides every reservation
-- that belongs to someone else. The overlap check and the daily-cap count
-- inside the trigger therefore only ever compared the new booking with that
-- same customer's own rows — an approved booking from another customer was
-- invisible, so it never blocked anything. The customer-facing availability
-- functions are SECURITY DEFINER and DO see everything, which is why the
-- screen looked correct while the database guard quietly did nothing.
-- (Managers/admins have a read-all policy, which is why approving a booking
-- was still checked correctly.)
--
-- Fix: run both trigger functions as their owner so the checks see every
-- reservation. ALTER FUNCTION is used instead of re-creating them: their
-- bodies (the latest are 20261026 / 20261016) are long and have been
-- accidentally reverted by a copy-paste once before (see the header of
-- 20261005_fix_pending_blocks_capacity.sql), and no logic needs to change.
-- Neither body reads auth.uid()/current_user/roles, so running as owner does
-- not change what they decide — only what rows they can see.
--
-- Behaviour that stays the same on purpose (20261005_fix_pending_blocks_
-- capacity.sql): a PENDING booking never blocks others. Two customers can
-- still both have a pending request for the same slot; once staff approve
-- one, the other can no longer be approved and shows the overlap error.
--
-- ── B. Root cause: the date calendar asked a different question ────────────
--   - get_booking_calendar_availability() probed every date with a fixed
--     1-hour booking and no room, so a date with only a 1-hour gap read as
--     open even for a 2-hour package.
--   - get_booking_availability() (the "is this date taken" check that runs
--     once a date is picked) did not receive the chosen room, while the time
--     grid did. A date whose chosen room was already at its daily limit still
--     read as "Selected <date>" and then showed a grid of disabled times.
-- Both now accept the same scope / duration / room the time grid uses and
-- delegate to get_available_start_times(), the single source of truth.
-- Every new parameter is optional and defaults to the previous behaviour, so
-- other callers (reschedule calendar, admin payments) are unaffected.
-- ═══════════════════════════════════════════════════════════════════════════

-- 1. Capacity triggers see every reservation.
alter function public.enforce_reservation_capacity() security definer set search_path = public;
alter function public.enforce_reschedule_capacity()  security definer set search_path = public;

-- 2. get_booking_availability — now room-aware.
drop function if exists public.get_booking_availability(date, text, integer, uuid);

create or replace function public.get_booking_availability(
  p_event_date             date,
  p_scope                  text default null,
  p_duration_hours         integer default null,
  p_exclude_reservation_id uuid default null,
  p_venue_id               uuid default null
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
  from public.get_available_start_times(p_event_date, p_scope, p_duration_hours, p_exclude_reservation_id, p_venue_id);

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

grant execute on function public.get_booking_availability(date, text, integer, uuid, uuid) to anon, authenticated;

-- 3. get_booking_calendar_availability — scope/duration/room aware.
--    With p_scope null it behaves exactly as before: all three scopes at a
--    1-hour probe, a date is "fully booked" only when every scope is
--    exhausted. With p_scope set it answers for that one booking.
drop function if exists public.get_booking_calendar_availability(date, date);

create or replace function public.get_booking_calendar_availability(
  p_from_date      date,
  p_to_date        date,
  p_scope          text    default null,
  p_duration_hours integer default null,
  p_venue_id       uuid    default null
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
  v_scopes    text[];
  v_scope     text;
  v_occupied  text[];
  v_available boolean;
  v_duration  integer := greatest(coalesce(p_duration_hours, 1), 1);
  v_venue_id  uuid;
begin
  if p_scope is null then
    v_scopes   := array['onsite_vip', 'onsite_main_hall', 'offsite'];
    v_venue_id := null;
  else
    v_scopes   := array[p_scope];
    v_venue_id := p_venue_id;
  end if;

  while v_date <= p_to_date loop
    v_occupied := '{}'::text[];

    foreach v_scope in array v_scopes loop
      select bool_or(s.is_available) into v_available
      from public.get_available_start_times(v_date, v_scope, v_duration, null, v_venue_id) s;

      if not coalesce(v_available, false) then
        v_occupied := array_append(v_occupied, v_scope);
      end if;
    end loop;

    event_date := v_date;
    occupied_scopes := v_occupied;
    is_fully_booked := (coalesce(array_length(v_occupied, 1), 0) = array_length(v_scopes, 1));
    return next;

    v_date := v_date + 1;
  end loop;
end;
$$;

grant execute on function public.get_booking_calendar_availability(date, date, text, integer, uuid) to anon, authenticated;

-- ── Verify after applying ──────────────────────────────────────────────────
-- Both triggers should now report prosecdef = true:
--   select proname, prosecdef from pg_proc
--   where proname in ('enforce_reservation_capacity', 'enforce_reschedule_capacity');
