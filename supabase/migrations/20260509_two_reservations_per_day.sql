-- ── 2-reservations-per-day booking limit ─────────────────────────────────────
-- Replaces the scope-based capacity system (onsite_vip / onsite_main_hall /
-- offsite) with a simple daily count cap: a date is fully booked once it has
-- 2 active (capacity-blocking) reservations, regardless of package type,
-- location type, or booking scope.
--
-- booking_scope and event_end_time columns are kept and still populated so
-- existing data stays consistent, but they no longer drive capacity checks.
-- Function signatures are unchanged so the frontend requires no edits.
-- ─────────────────────────────────────────────────────────────────────────────


-- 1. enforce_reservation_capacity ─────────────────────────────────────────────
create or replace function public.enforce_reservation_capacity()
returns trigger
language plpgsql
as $$
declare
  v_package_name   text;
  v_duration_hours integer := 3;
  v_scope          text;
  v_start_time     time;
  v_end_time       time;
  v_daily_count    integer;
  v_event_label    text;
begin
  -- Still populate booking_scope / event_end_time for historical data.
  select p.package_name, coalesce(p.duration_hours, 3)
  into   v_package_name, v_duration_hours
  from   public.package p
  where  p.package_id = new.package_id;

  v_scope          := public.normalize_booking_scope(new.location_type, v_package_name);
  new.booking_scope := v_scope;

  v_start_time := public.parse_event_time_text(new.event_time);
  if v_start_time is not null and coalesce(v_duration_hours, 0) > 0 then
    v_end_time := (v_start_time + make_interval(hours => v_duration_hours))::time;
  else
    v_end_time := null;
  end if;
  new.event_end_time := v_end_time;

  -- Skip capacity check for non-blocking statuses (e.g. cancelled, completed).
  if not public.is_capacity_blocking_reservation_status(new.status) then
    return new;
  end if;

  if new.event_date is null then
    return new;
  end if;

  -- Count all active reservations on this date, excluding current row on UPDATE.
  select count(*)
  into   v_daily_count
  from   public.reservations r
  where  r.event_date = new.event_date
    and  public.is_capacity_blocking_reservation_status(r.status)
    and  r.reservation_id <> coalesce(
           new.reservation_id,
           '00000000-0000-0000-0000-000000000000'::uuid
         );

  if v_daily_count >= 2 then
    v_event_label := to_char(new.event_date::timestamp, 'FMMonth DD, YYYY');
    raise exception using
      errcode = 'P0001',
      message  = 'This date is fully booked. A maximum of 2 reservations are accepted per day ('
                 || v_event_label || ').';
  end if;

  return new;
end;
$$;


-- 2. enforce_reschedule_capacity ──────────────────────────────────────────────
create or replace function public.enforce_reschedule_capacity()
returns trigger
language plpgsql
as $$
declare
  v_reservation public.reservations%rowtype;
  v_daily_count integer;
  v_event_label text;
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

  if new.requested_date is null then
    return new;
  end if;

  -- Count active reservations on the requested date, excluding the reservation
  -- being rescheduled (it will vacate its original date if approved).
  select count(*)
  into   v_daily_count
  from   public.reservations r
  where  r.event_date = new.requested_date
    and  public.is_capacity_blocking_reservation_status(r.status)
    and  r.reservation_id <> v_reservation.reservation_id;

  if v_daily_count >= 2 then
    v_event_label := to_char(new.requested_date::timestamp, 'FMMonth DD, YYYY');
    raise exception using
      errcode = 'P0001',
      message  = 'This date is fully booked. A maximum of 2 reservations are accepted per day ('
                 || v_event_label || ').';
  end if;

  return new;
end;
$$;


-- 3. get_booking_availability ─────────────────────────────────────────────────
-- p_scope and p_duration_hours are accepted but unused (kept for API compat).
create or replace function public.get_booking_availability(
  p_event_date            date,
  p_scope                 text    default null,
  p_duration_hours        integer default null,
  p_exclude_reservation_id uuid   default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_daily_count    integer;
  v_occupied_scopes text[];
  v_is_fully_booked boolean;
  v_blocked_times  text[];
begin
  select
    count(*),
    coalesce(
      array_agg(distinct r.booking_scope order by r.booking_scope)
        filter (where r.booking_scope is not null),
      '{}'::text[]
    )
  into v_daily_count, v_occupied_scopes
  from public.reservations r
  where r.event_date = p_event_date
    and public.is_capacity_blocking_reservation_status(r.status)
    and (p_exclude_reservation_id is null or r.reservation_id <> p_exclude_reservation_id);

  v_is_fully_booked := v_daily_count >= 2;

  -- When the day is full, every time slot is unavailable.
  if v_is_fully_booked then
    v_blocked_times := array[
      '1:00 PM', '2:00 PM', '3:00 PM', '4:00 PM', '5:00 PM',
      '6:00 PM', '7:00 PM', '8:00 PM', '9:00 PM', '10:00 PM'
    ];
  else
    v_blocked_times := '{}'::text[];
  end if;

  return jsonb_build_object(
    'event_date',      p_event_date,
    'daily_count',     v_daily_count,
    'occupied_scopes', v_occupied_scopes,
    'is_fully_booked', v_is_fully_booked,
    'scope_taken',     v_is_fully_booked,
    'blocked_times',   v_blocked_times
  );
end;
$$;


-- 4. get_booking_calendar_availability ────────────────────────────────────────
create or replace function public.get_booking_calendar_availability(
  p_from_date date,
  p_to_date   date
)
returns table (
  event_date     date,
  occupied_scopes text[],
  is_fully_booked boolean
)
language sql
security definer
set search_path = public
as $$
  select
    r.event_date,
    coalesce(
      array_agg(distinct r.booking_scope order by r.booking_scope)
        filter (where r.booking_scope is not null),
      '{}'::text[]
    ) as occupied_scopes,
    count(*) >= 2 as is_fully_booked
  from  public.reservations r
  where r.event_date between p_from_date and p_to_date
    and public.is_capacity_blocking_reservation_status(r.status)
  group by r.event_date
  order by r.event_date;
$$;


grant execute on function public.get_booking_availability(date, text, integer, uuid) to anon, authenticated;
grant execute on function public.get_booking_calendar_availability(date, date) to anon, authenticated;
