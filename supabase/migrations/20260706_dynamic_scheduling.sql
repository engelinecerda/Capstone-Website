-- ── Dynamic schedule availability management ─────────────────────────────────
-- Replaces the flat "2 reservations per day, no time awareness" model
-- (20260509_two_reservations_per_day.sql) with a layered model:
--   1. Daily cap (kept, unchanged: max 2 active reservations per calendar date)
--   2. Real time-range overlap per booking scope (restored from the
--      pre-20260509 generation, using the same booking_times_overlap() /
--      booking_scopes_overlap_by_time() helpers, minus the old redundant
--      "any reservation already exists in this scope today" rule that used
--      to forbid two non-overlapping same-day bookings in the same scope.
-- Also adds a dynamic start-time generator (get_available_start_times) and
-- admin-configurable operating hours via system_settings.
-- ─────────────────────────────────────────────────────────────────────────────

-- 1. New columns on reservations ──────────────────────────────────────────────
alter table public.reservations
  add column if not exists start_time     time,
  add column if not exists duration_hours integer;

-- Backfill existing rows so historical data stays consistent.
update public.reservations r
set
  start_time     = public.parse_event_time_text(r.event_time),
  duration_hours = coalesce(p.duration_hours, 3)
from public.package p
where p.package_id = r.package_id
  and (r.start_time is null or r.duration_hours is null);


-- 2. Default operating-hours setting (admin-editable via Settings UI) ────────
-- Note: setting_value is stored as text (JSON-encoded), matching the existing
-- venue_map_scope row and js/super_admin_settings.js's JSON.stringify/parse
-- pattern — not jsonb, despite the original 20260513_create_system_settings.sql
-- migration declaring a jsonb column (that file is stale vs. the live schema).
insert into public.system_settings (setting_key, setting_value)
values (
  'booking_operating_hours',
  '{"open_time": "13:00", "close_time": "22:00"}'
)
on conflict (setting_key) do nothing;


-- 3. enforce_reservation_capacity — daily cap + restored time overlap ────────
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
  v_scope_label    text;
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

  -- Daily cap (kept from the 2026-05-09 rewrite).
  select count(*)
  into   v_daily_count
  from   public.reservations r
  where  r.event_date = new.event_date
    and  public.is_capacity_blocking_reservation_status(r.status)
    and  r.reservation_id <> coalesce(new.reservation_id, '00000000-0000-0000-0000-000000000000'::uuid);

  if v_daily_count >= 2 then
    v_event_label := to_char(new.event_date::timestamp, 'FMMonth DD, YYYY');
    raise exception using
      errcode = 'P0001',
      message = 'This date is fully booked. A maximum of 2 reservations are accepted per day ('
                || v_event_label || ').';
  end if;

  -- Time-range overlap per booking scope (restored). A same-scope reservation
  -- earlier or later the same day that does NOT overlap is now allowed.
  if v_scope is not null and v_start_time is not null and v_end_time is not null then
    if exists (
      select 1
      from public.reservations r
      left join public.package rp on rp.package_id = r.package_id
      where r.event_date = new.event_date
        and public.is_capacity_blocking_reservation_status(r.status)
        and r.reservation_id <> coalesce(new.reservation_id, '00000000-0000-0000-0000-000000000000'::uuid)
        and public.booking_scopes_overlap_by_time(
          v_scope,
          coalesce(r.booking_scope, public.normalize_booking_scope(r.location_type, rp.package_name))
        )
        and public.booking_times_overlap(
          v_start_time,
          v_end_time,
          coalesce(r.start_time, public.parse_event_time_text(r.event_time)),
          coalesce(
            r.event_end_time,
            (
              coalesce(r.start_time, public.parse_event_time_text(r.event_time))
              + make_interval(hours => coalesce(rp.duration_hours, 3))
            )::time
          )
        )
    ) then
      v_scope_label := case v_scope
        when 'onsite_vip' then 'VIP'
        when 'onsite_main_hall' then 'Main Hall'
        when 'offsite' then 'Off-site'
        else 'Selected'
      end;
      raise exception using
        errcode = 'P0001',
        message = v_scope_label || ' is already booked during that time range on the selected date.';
    end if;
  end if;

  return new;
end;
$$;


-- 4. enforce_reschedule_capacity — mirrors the same two checks ───────────────
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
  v_daily_count    integer;
  v_event_label    text;
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
      message = 'This date is fully booked. A maximum of 2 reservations are accepted per day ('
                || v_event_label || ').';
  end if;

  if v_scope is not null and v_start_time is not null and v_end_time is not null then
    if exists (
      select 1
      from public.reservations r
      left join public.package rp on rp.package_id = r.package_id
      where r.event_date = new.requested_date
        and public.is_capacity_blocking_reservation_status(r.status)
        and r.reservation_id <> v_reservation.reservation_id
        and public.booking_scopes_overlap_by_time(
          v_scope,
          coalesce(r.booking_scope, public.normalize_booking_scope(r.location_type, rp.package_name))
        )
        and public.booking_times_overlap(
          v_start_time,
          v_end_time,
          coalesce(r.start_time, public.parse_event_time_text(r.event_time)),
          coalesce(
            r.event_end_time,
            (
              coalesce(r.start_time, public.parse_event_time_text(r.event_time))
              + make_interval(hours => coalesce(rp.duration_hours, 3))
            )::time
          )
        )
    ) then
      v_scope_label := case v_scope
        when 'onsite_vip' then 'VIP'
        when 'onsite_main_hall' then 'Main Hall'
        when 'offsite' then 'Off-site'
        else 'Selected'
      end;
      raise exception using
        errcode = 'P0001',
        message = v_scope_label || ' is already booked during that time range on the selected date.';
    end if;
  end if;

  return new;
end;
$$;


-- 5. get_available_start_times — dynamic per-interval slot generator ─────────
-- The 30-minute interval below is the one knob to change for a different
-- granularity (15/20/etc). Operating hours are read from system_settings.
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
  v_open             time;
  v_close            time;
  v_interval_minutes integer := 30;
  v_duration         integer := greatest(coalesce(p_duration_hours, 1), 1);
  v_daily_count      integer;
  v_last_offset      integer;
  v_setting_text     text;
  v_setting          jsonb;
begin
  select setting_value into v_setting_text
  from public.system_settings
  where setting_key = 'booking_operating_hours';

  begin
    v_setting := v_setting_text::jsonb;
  exception when others then
    v_setting := null;
  end;

  v_open  := coalesce((v_setting->>'open_time')::time, '13:00'::time);
  v_close := coalesce((v_setting->>'close_time')::time, '22:00'::time);

  select count(*)
  into v_daily_count
  from public.reservations r
  where r.event_date = p_event_date
    and public.is_capacity_blocking_reservation_status(r.status)
    and (p_exclude_reservation_id is null or r.reservation_id <> p_exclude_reservation_id);

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
      exists (
        select 1
        from public.reservations r
        left join public.package rp on rp.package_id = r.package_id
        where r.event_date = p_event_date
          and public.is_capacity_blocking_reservation_status(r.status)
          and (p_exclude_reservation_id is null or r.reservation_id <> p_exclude_reservation_id)
          and public.booking_scopes_overlap_by_time(
            p_scope,
            coalesce(r.booking_scope, public.normalize_booking_scope(r.location_type, rp.package_name))
          )
          and public.booking_times_overlap(
            s.slot_start,
            (s.slot_start + make_interval(hours => v_duration))::time,
            coalesce(r.start_time, public.parse_event_time_text(r.event_time)),
            coalesce(
              r.event_end_time,
              (
                coalesce(r.start_time, public.parse_event_time_text(r.event_time))
                + make_interval(hours => coalesce(rp.duration_hours, 3))
              )::time
            )
          )
      ) as has_overlap
    from slots s
  )
  select
    to_char(p_event_date + ss.slot_start, 'FMHH12:MI AM'),
    ss.slot_start,
    (ss.slot_start + make_interval(hours => v_duration))::time,
    (v_daily_count < 2 and p_scope is not null and not ss.has_overlap),
    case
      when v_daily_count >= 2 then 'This date has reached the maximum of 2 reservations per day.'
      when p_scope is null then 'Select a package first.'
      when ss.has_overlap then 'Unavailable due to another reservation.'
      else null
    end
  from slot_status ss
  order by ss.slot_start;
end;
$$;

grant execute on function public.get_available_start_times(date, text, integer, uuid) to anon, authenticated;
