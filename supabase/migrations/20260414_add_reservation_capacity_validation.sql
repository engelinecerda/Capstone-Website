alter table public.package
  add column if not exists duration_hours integer;

update public.package
set duration_hours = case
  when lower(coalesce(package_name, '')) = 'vip lite' then 2
  when lower(coalesce(package_name, '')) = 'vip plus' then 3
  when lower(coalesce(package_name, '')) = 'vip max' then 4
  when lower(coalesce(package_name, '')) = 'main hall basic' then 2
  when lower(coalesce(package_name, '')) = 'main hall plus' then 3
  when lower(coalesce(package_name, '')) like '%coffee%' then 3
  when lower(coalesce(package_name, '')) like '%snack%' then 3
  when lower(coalesce(package_name, '')) like '%biscuit%' then 3
  when lower(coalesce(package_name, '')) like '%catering%' then 4
  else coalesce(duration_hours, 3)
end;

alter table public.package
  alter column duration_hours set default 3;

alter table public.package
  alter column duration_hours set not null;

alter table public.reservations
  add column if not exists booking_scope text;

alter table public.reservations
  add column if not exists event_end_time time;

create index if not exists reservations_event_date_scope_idx
  on public.reservations (event_date, booking_scope);

create or replace function public.normalize_booking_scope(
  p_location_type text,
  p_package_name text
)
returns text
language plpgsql
immutable
as $$
declare
  v_location text := lower(coalesce(p_location_type, ''));
  v_package_name text := lower(coalesce(p_package_name, ''));
begin
  if v_location = 'offsite' then
    return 'offsite';
  end if;

  if v_location = 'onsite' and v_package_name like '%main hall%' then
    return 'onsite_main_hall';
  end if;

  if v_location = 'onsite' and v_package_name like '%vip%' then
    return 'onsite_vip';
  end if;

  return null;
end;
$$;

create or replace function public.parse_event_time_text(p_value text)
returns time
language plpgsql
immutable
as $$
declare
  v_value text := trim(coalesce(p_value, ''));
  v_time time;
begin
  if v_value = '' then
    return null;
  end if;

  begin
    v_time := v_value::time;
    return v_time;
  exception when others then
    null;
  end;

  begin
    v_time := to_timestamp(upper(v_value), 'HH12:MI AM')::time;
    return v_time;
  exception when others then
    null;
  end;

  begin
    v_time := to_timestamp(upper(v_value), 'HH12 AM')::time;
    return v_time;
  exception when others then
    null;
  end;

  return null;
end;
$$;

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
    and p_start_a < p_end_b
    and p_end_a > p_start_b
$$;

create or replace function public.enforce_reservation_capacity()
returns trigger
language plpgsql
as $$
declare
  v_package_name text;
  v_duration_hours integer := 3;
  v_scope text;
  v_start_time time;
  v_end_time time;
  v_scope_label text;
  v_event_label text;
begin
  select p.package_name, coalesce(p.duration_hours, 3)
  into v_package_name, v_duration_hours
  from public.package p
  where p.package_id = new.package_id;

  v_scope := public.normalize_booking_scope(new.location_type, v_package_name);
  new.booking_scope := v_scope;

  v_start_time := public.parse_event_time_text(new.event_time);
  if v_start_time is not null and coalesce(v_duration_hours, 0) > 0 then
    v_end_time := (v_start_time + make_interval(hours => v_duration_hours))::time;
  else
    v_end_time := null;
  end if;
  new.event_end_time := v_end_time;

  if lower(coalesce(new.status, '')) not in ('pending', 'approved', 'confirmed', 'rescheduled') then
    return new;
  end if;

  if new.event_date is null or v_scope is null then
    return new;
  end if;

  if exists (
    select 1
    from public.reservations r
    left join public.package rp on rp.package_id = r.package_id
    where r.event_date = new.event_date
      and lower(coalesce(r.status, '')) in ('pending', 'approved', 'confirmed', 'rescheduled')
      and coalesce(r.booking_scope, public.normalize_booking_scope(r.location_type, rp.package_name)) = v_scope
      and r.reservation_id <> coalesce(new.reservation_id, '00000000-0000-0000-0000-000000000000'::uuid)
      and public.booking_times_overlap(
        v_start_time,
        v_end_time,
        public.parse_event_time_text(r.event_time),
        coalesce(
          r.event_end_time,
          (
            public.parse_event_time_text(r.event_time)
            + make_interval(hours => coalesce(rp.duration_hours, 3))
          )::time
        )
      )
  ) then
    raise exception using
      errcode = 'P0001',
      message = 'This reservation overlaps an existing booking for the selected date and scope.';
  end if;

  if exists (
    select 1
    from public.reservations r
    left join public.package rp on rp.package_id = r.package_id
    where r.event_date = new.event_date
      and lower(coalesce(r.status, '')) in ('pending', 'approved', 'confirmed', 'rescheduled')
      and coalesce(r.booking_scope, public.normalize_booking_scope(r.location_type, rp.package_name)) = v_scope
      and r.reservation_id <> coalesce(new.reservation_id, '00000000-0000-0000-0000-000000000000'::uuid)
  ) then
    v_scope_label := case v_scope
      when 'onsite_vip' then 'VIP'
      when 'onsite_main_hall' then 'Main Hall'
      when 'offsite' then 'Off-site'
      else 'Selected'
    end;
    v_event_label := to_char(new.event_date::timestamp, 'FMMonth DD, YYYY');

    raise exception using
      errcode = 'P0001',
      message = v_scope_label || ' is already booked on ' || v_event_label || '.';
  end if;

  return new;
end;
$$;

drop trigger if exists reservations_enforce_capacity on public.reservations;
create trigger reservations_enforce_capacity
before insert or update on public.reservations
for each row
execute function public.enforce_reservation_capacity();

create or replace function public.enforce_reschedule_capacity()
returns trigger
language plpgsql
as $$
declare
  v_reservation public.reservations%rowtype;
  v_package_name text;
  v_duration_hours integer := 3;
  v_scope text;
  v_start_time time;
  v_end_time time;
  v_scope_label text;
  v_event_label text;
begin
  if lower(coalesce(new.status, 'pending')) in ('rejected', 'completed') then
    return new;
  end if;

  select r.*
  into v_reservation
  from public.reservations r
  where r.reservation_id = new.reservation_id;

  if v_reservation.reservation_id is null then
    return new;
  end if;

  select p.package_name, coalesce(p.duration_hours, 3)
  into v_package_name, v_duration_hours
  from public.package p
  where p.package_id = v_reservation.package_id;

  v_scope := public.normalize_booking_scope(v_reservation.location_type, v_package_name);
  v_start_time := public.parse_event_time_text(new.requested_time);
  if v_start_time is not null and coalesce(v_duration_hours, 0) > 0 then
    v_end_time := (v_start_time + make_interval(hours => v_duration_hours))::time;
  else
    v_end_time := null;
  end if;

  if new.requested_date is null or v_scope is null then
    return new;
  end if;

  if exists (
    select 1
    from public.reservations r
    left join public.package rp on rp.package_id = r.package_id
    where r.event_date = new.requested_date
      and lower(coalesce(r.status, '')) in ('pending', 'approved', 'confirmed', 'rescheduled')
      and coalesce(r.booking_scope, public.normalize_booking_scope(r.location_type, rp.package_name)) = v_scope
      and r.reservation_id <> v_reservation.reservation_id
      and public.booking_times_overlap(
        v_start_time,
        v_end_time,
        public.parse_event_time_text(r.event_time),
        coalesce(
          r.event_end_time,
          (
            public.parse_event_time_text(r.event_time)
            + make_interval(hours => coalesce(rp.duration_hours, 3))
          )::time
        )
      )
  ) then
    raise exception using
      errcode = 'P0001',
      message = 'This reschedule request overlaps an existing booking for the selected date and scope.';
  end if;

  if exists (
    select 1
    from public.reservations r
    left join public.package rp on rp.package_id = r.package_id
    where r.event_date = new.requested_date
      and lower(coalesce(r.status, '')) in ('pending', 'approved', 'confirmed', 'rescheduled')
      and coalesce(r.booking_scope, public.normalize_booking_scope(r.location_type, rp.package_name)) = v_scope
      and r.reservation_id <> v_reservation.reservation_id
  ) then
    v_scope_label := case v_scope
      when 'onsite_vip' then 'VIP'
      when 'onsite_main_hall' then 'Main Hall'
      when 'offsite' then 'Off-site'
      else 'Selected'
    end;
    v_event_label := to_char(new.requested_date::timestamp, 'FMMonth DD, YYYY');

    raise exception using
      errcode = 'P0001',
      message = v_scope_label || ' is already booked on ' || v_event_label || '.';
  end if;

  return new;
end;
$$;

drop trigger if exists reschedule_requests_enforce_capacity on public.reschedule_requests;
create trigger reschedule_requests_enforce_capacity
before insert or update on public.reschedule_requests
for each row
execute function public.enforce_reschedule_capacity();

update public.reservations r
set
  booking_scope = public.normalize_booking_scope(r.location_type, p.package_name),
  event_end_time = case
    when public.parse_event_time_text(r.event_time) is null then null
    else (
      public.parse_event_time_text(r.event_time)
      + make_interval(hours => coalesce(p.duration_hours, 3))
    )::time
  end
from public.package p
where p.package_id = r.package_id
  and (
    r.booking_scope is null
    or r.event_end_time is null
  );

create or replace function public.get_booking_availability(
  p_event_date date,
  p_scope text default null,
  p_duration_hours integer default null,
  p_exclude_reservation_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_occupied_scopes text[];
  v_scope_taken boolean;
  v_blocked_times text[] := '{}'::text[];
begin
  select coalesce(array_agg(distinct scope_value order by scope_value), '{}'::text[])
  into v_occupied_scopes
  from (
    select coalesce(r.booking_scope, public.normalize_booking_scope(r.location_type, p.package_name)) as scope_value
    from public.reservations r
    left join public.package p on p.package_id = r.package_id
    where r.event_date = p_event_date
      and lower(coalesce(r.status, '')) in ('pending', 'approved', 'confirmed', 'rescheduled')
      and (p_exclude_reservation_id is null or r.reservation_id <> p_exclude_reservation_id)
  ) scopes
  where scope_value is not null;

  v_scope_taken := p_scope is not null and p_scope = any(v_occupied_scopes);

  if v_scope_taken then
    v_blocked_times := array[
      '1:00 PM', '2:00 PM', '3:00 PM', '4:00 PM', '5:00 PM',
      '6:00 PM', '7:00 PM', '8:00 PM', '9:00 PM', '10:00 PM'
    ];
  end if;

  return jsonb_build_object(
    'event_date', p_event_date,
    'occupied_scopes', v_occupied_scopes,
    'is_fully_booked', (
      'onsite_vip' = any(v_occupied_scopes)
      and 'onsite_main_hall' = any(v_occupied_scopes)
      and 'offsite' = any(v_occupied_scopes)
    ),
    'scope_taken', v_scope_taken,
    'blocked_times', v_blocked_times
  );
end;
$$;

create or replace function public.get_booking_calendar_availability(
  p_from_date date,
  p_to_date date
)
returns table (
  event_date date,
  occupied_scopes text[],
  is_fully_booked boolean
)
language sql
security definer
set search_path = public
as $$
  with scoped_reservations as (
    select
      r.event_date,
      coalesce(r.booking_scope, public.normalize_booking_scope(r.location_type, p.package_name)) as booking_scope
    from public.reservations r
    left join public.package p on p.package_id = r.package_id
    where r.event_date between p_from_date and p_to_date
      and lower(coalesce(r.status, '')) in ('pending', 'approved', 'confirmed', 'rescheduled')
  )
  select
    sr.event_date,
    array_agg(distinct sr.booking_scope order by sr.booking_scope) as occupied_scopes,
    bool_or(sr.booking_scope = 'onsite_vip')
      and bool_or(sr.booking_scope = 'onsite_main_hall')
      and bool_or(sr.booking_scope = 'offsite') as is_fully_booked
  from scoped_reservations sr
  where sr.booking_scope is not null
  group by sr.event_date
  order by sr.event_date;
$$;

grant execute on function public.get_booking_availability(date, text, integer, uuid) to anon, authenticated;
grant execute on function public.get_booking_calendar_availability(date, date) to anon, authenticated;
