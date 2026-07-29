-- Availability & Scheduling Configuration (Admin).
--
-- Replaces two café-wide, hardcoded rules —
--   (a) a single global open/close time (system_settings.booking_operating_hours)
--   (b) a flat "max 2 reservations per day" cap, plus a binary same-scope
--       time-overlap reject (enforce_reservation_capacity /
--       enforce_reschedule_capacity / get_available_start_times,
--       20260706_dynamic_scheduling.sql)
-- with per-weekday operating hours and a buffer + per-scope capacity model:
-- a scope (onsite_vip / onsite_main_hall / offsite) may now hold more than
-- one booking at a time, up to its resolved capacity, as long as each
-- booking's time window (padded by buffer_minutes on both sides) doesn't
-- push the concurrent count at/over that capacity.
--
-- Scope, not venue: reservations don't record which physical venue was
-- booked (no venue_id column), only the existing 3-value booking_scope
-- derived from location_type + package name (normalize_booking_scope()).
-- Capacity is keyed to that existing scope, not to public.venue — building
-- real per-venue capacity would require adding reservations.venue_id and
-- venue selection to the customer booking flow, out of scope here.
--
-- Fixed named slots were considered and rejected — get_available_start_times()
-- is a live, working dynamic 30-minute slot generator already called by the
-- customer reservation form (js/reservation_availability.js); this migration
-- extends it rather than replacing it with an admin-defined slot list.
--
-- calendar_blackouts is NOT touched by this migration — blackout dates stay
-- entirely the Manager's, read-only (client-side only, unchanged) elsewhere.
-- ─────────────────────────────────────────────────────────────────────────────

-- ═══════════════════════════════════════════════════════════════════════════
-- 1. SCHEMA
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists public.operating_hours (
  weekday    int primary key check (weekday between 0 and 6),  -- 0 = Sunday
  is_open    boolean not null default true,
  open_time  time,
  close_time time,
  constraint hours_when_open check (
    not is_open or (open_time is not null and close_time is not null and open_time < close_time)
  )
);

-- Seed all 7 days from today's single global system_settings.booking_operating_hours
-- value (13:00–22:00) so behavior is unchanged until an admin edits a specific day.
insert into public.operating_hours (weekday, is_open, open_time, close_time)
select d, true, '13:00'::time, '22:00'::time
from generate_series(0, 6) as d
on conflict (weekday) do nothing;

create table if not exists public.scheduling_settings (
  id                    boolean primary key default true,
  buffer_minutes        int not null default 30 check (buffer_minutes >= 0),
  default_slot_capacity int not null default 2 check (default_slot_capacity >= 1),
  updated_at            timestamptz not null default now(),
  updated_by            uuid references auth.users(id),
  constraint singleton check (id)
);
insert into public.scheduling_settings (id) values (true) on conflict (id) do nothing;

-- Per-scope override, keyed to the existing 3-value booking_scope — not a new
-- venue_id concept. Missing row / null capacity falls back to
-- scheduling_settings.default_slot_capacity.
create table if not exists public.scope_capacity (
  scope      text primary key check (scope in ('onsite_vip', 'onsite_main_hall', 'offsite')),
  capacity   int check (capacity is null or capacity >= 1),
  updated_at timestamptz not null default now()
);

-- ═══════════════════════════════════════════════════════════════════════════
-- 2. RLS — public read (booking flow builds the calendar from these), admin
--    write, matching the standard get_my_role() = 'admin' convention.
-- ═══════════════════════════════════════════════════════════════════════════

alter table public.operating_hours enable row level security;
drop policy if exists "Public read operating hours" on public.operating_hours;
create policy "Public read operating hours" on public.operating_hours for select using (true);
drop policy if exists "Admin manage operating hours" on public.operating_hours;
create policy "Admin manage operating hours" on public.operating_hours
  for all using (get_my_role() = 'admin') with check (get_my_role() = 'admin');

alter table public.scheduling_settings enable row level security;
drop policy if exists "Public read scheduling settings" on public.scheduling_settings;
create policy "Public read scheduling settings" on public.scheduling_settings for select using (true);
drop policy if exists "Admin manage scheduling settings" on public.scheduling_settings;
create policy "Admin manage scheduling settings" on public.scheduling_settings
  for all using (get_my_role() = 'admin') with check (get_my_role() = 'admin');

alter table public.scope_capacity enable row level security;
drop policy if exists "Public read scope capacity" on public.scope_capacity;
create policy "Public read scope capacity" on public.scope_capacity for select using (true);
drop policy if exists "Admin manage scope capacity" on public.scope_capacity;
create policy "Admin manage scope capacity" on public.scope_capacity
  for all using (get_my_role() = 'admin') with check (get_my_role() = 'admin');

-- ═══════════════════════════════════════════════════════════════════════════
-- 3. enforce_reservation_capacity — closed-weekday + buffer/capacity-count
--    replaces the flat daily cap + binary same-scope overlap reject.
-- ═══════════════════════════════════════════════════════════════════════════

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
  v_weekday        integer;
  v_is_open        boolean;
  v_weekday_label  text;
  v_buffer_minutes integer := 30;
  v_capacity       integer := 2;
  v_scope_override integer;
  v_padded_start   time;
  v_padded_end     time;
  v_overlap_count  integer;
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

  -- Closed weekday.
  v_weekday := extract(dow from new.event_date);
  select is_open into v_is_open from public.operating_hours where weekday = v_weekday;
  if coalesce(v_is_open, true) is false then
    v_weekday_label := trim(to_char(new.event_date::timestamp, 'FMDay'));
    raise exception using
      errcode = 'P0001',
      message = 'The café is closed on ' || v_weekday_label || 's — please choose a different date.';
  end if;

  -- Buffer-padded, per-scope capacity count (replaces the old flat daily cap
  -- and the old binary "any same-scope overlap = reject" check).
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

    if v_overlap_count >= v_capacity then
      v_scope_label := case v_scope
        when 'onsite_vip' then 'VIP'
        when 'onsite_main_hall' then 'Main Hall'
        when 'offsite' then 'Off-site'
        else 'Selected'
      end;
      raise exception using
        errcode = 'P0001',
        message = v_scope_label || ' is fully booked for that time.';
    end if;
  end if;

  return new;
end;
$$;

-- ═══════════════════════════════════════════════════════════════════════════
-- 4. enforce_reschedule_capacity — mirrors the same two checks.
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

    if v_overlap_count >= v_capacity then
      v_scope_label := case v_scope
        when 'onsite_vip' then 'VIP'
        when 'onsite_main_hall' then 'Main Hall'
        when 'offsite' then 'Off-site'
        else 'Selected'
      end;
      raise exception using
        errcode = 'P0001',
        message = v_scope_label || ' is fully booked for that time.';
    end if;
  end if;

  return new;
end;
$$;

-- ═══════════════════════════════════════════════════════════════════════════
-- 5. get_available_start_times — per-weekday hours + buffer/capacity-count,
--    mirroring the trigger exactly so nothing the calendar offers gets
--    rejected at submit time.
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
    (p_scope is not null and ss.overlap_count < v_capacity),
    case
      when p_scope is null then 'Select a package first.'
      when ss.overlap_count >= v_capacity then 'Unavailable due to another reservation.'
      else null
    end
  from slot_status ss
  order by ss.slot_start;
end;
$$;

grant execute on function public.get_available_start_times(date, text, integer, uuid) to anon, authenticated;
