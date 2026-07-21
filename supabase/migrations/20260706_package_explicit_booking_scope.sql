-- ── Explicit package booking scope ────────────────────────────────────────────
-- Booking scope (which team/resource a package occupies: onsite_vip,
-- onsite_main_hall, or offsite) was previously derived only by matching
-- substrings in the package name (public.normalize_booking_scope), duplicated
-- in SQL and in js/reservation_availability.js. Any admin-added or renamed
-- package that didn't match one of those substrings silently broke booking
-- (calendar/time grid would lock up with no scope resolved).
--
-- This migration makes booking scope an explicit, admin-set column on
-- package, populated via a required dropdown in the Packages admin UI.
-- normalize_booking_scope() is kept as a fallback only, for any package a
-- future admin session hasn't configured yet — it is no longer the primary
-- mechanism.
-- ─────────────────────────────────────────────────────────────────────────────

alter table public.package
  add column if not exists booking_scope text;

alter table public.package
  drop constraint if exists package_booking_scope_check;

alter table public.package
  add constraint package_booking_scope_check
  check (booking_scope in ('onsite_vip', 'onsite_main_hall', 'offsite') or booking_scope is null);

-- One-time backfill using the existing derivation logic, so every existing
-- package's current (already-correct) behavior becomes explicit instead of
-- implicit. Zero behavior change for existing packages.
update public.package
set booking_scope = public.normalize_booking_scope(location_type, package_name)
where booking_scope is null;


-- enforce_reservation_capacity — package.booking_scope now takes priority.
create or replace function public.enforce_reservation_capacity()
returns trigger
language plpgsql
as $$
declare
  v_package_name   text;
  v_duration_hours integer := 3;
  v_package_scope  text;
  v_scope          text;
  v_start_time     time;
  v_end_time       time;
  v_daily_count    integer;
  v_event_label    text;
  v_scope_label    text;
begin
  select p.package_name, coalesce(p.duration_hours, 3), p.booking_scope
  into   v_package_name, v_duration_hours, v_package_scope
  from   public.package p
  where  p.package_id = new.package_id;

  v_scope            := coalesce(v_package_scope, public.normalize_booking_scope(new.location_type, v_package_name));
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
          coalesce(r.booking_scope, rp.booking_scope, public.normalize_booking_scope(r.location_type, rp.package_name))
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


-- enforce_reschedule_capacity — mirrors the same priority change.
create or replace function public.enforce_reschedule_capacity()
returns trigger
language plpgsql
as $$
declare
  v_reservation    public.reservations%rowtype;
  v_package_name   text;
  v_duration_hours integer := 3;
  v_package_scope  text;
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

  select p.package_name, coalesce(p.duration_hours, 3), p.booking_scope
  into   v_package_name, v_duration_hours, v_package_scope
  from   public.package p
  where  p.package_id = v_reservation.package_id;

  v_scope      := coalesce(v_package_scope, public.normalize_booking_scope(v_reservation.location_type, v_package_name));
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
          coalesce(r.booking_scope, rp.booking_scope, public.normalize_booking_scope(r.location_type, rp.package_name))
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


-- get_available_start_times — prefer package.booking_scope for OTHER existing
-- reservations' scope when checking overlap against the requested p_scope.
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
            coalesce(r.booking_scope, rp.booking_scope, public.normalize_booking_scope(r.location_type, rp.package_name))
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
