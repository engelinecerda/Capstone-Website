alter table public.reservations
  add column if not exists pricing_breakdown text,
  add column if not exists admin_notes text;

alter table public.reservation_contracts
  add column if not exists admin_contract_url text;

alter table public.reservations
  alter column status set default 'pending_review';

update public.package
set location_type = 'offsite'
where package_name like 'All-Occasion Party Package%';

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
  if v_location = 'offsite'
    or v_package_name like '%all-occasion%'
    or v_package_name like '%all occasion%'
    or v_package_name like '%birthday / baptism all in package%'
  then
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

create or replace function public.is_capacity_blocking_reservation_status(p_status text)
returns boolean
language sql
immutable
as $$
  select lower(coalesce(p_status, '')) in (
    'pending',
    'pending_review',
    'for_finalization',
    'for_contract_signing',
    'approved',
    'confirmed',
    'partially_paid',
    'fully_paid',
    'rescheduled'
  )
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

  if not public.is_capacity_blocking_reservation_status(new.status) then
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
      and public.is_capacity_blocking_reservation_status(r.status)
      and r.reservation_id <> coalesce(new.reservation_id, '00000000-0000-0000-0000-000000000000'::uuid)
      and public.booking_scopes_overlap_by_time(
        v_scope,
        coalesce(r.booking_scope, public.normalize_booking_scope(r.location_type, rp.package_name))
      )
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
      message = 'This reservation overlaps an existing booking for the selected date and schedule.';
  end if;

  if exists (
    select 1
    from public.reservations r
    left join public.package rp on rp.package_id = r.package_id
    where r.event_date = new.event_date
      and public.is_capacity_blocking_reservation_status(r.status)
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
      and public.is_capacity_blocking_reservation_status(r.status)
      and r.reservation_id <> v_reservation.reservation_id
      and public.booking_scopes_overlap_by_time(
        v_scope,
        coalesce(r.booking_scope, public.normalize_booking_scope(r.location_type, rp.package_name))
      )
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
      message = 'This reschedule request overlaps an existing booking for the selected date and schedule.';
  end if;

  if exists (
    select 1
    from public.reservations r
    left join public.package rp on rp.package_id = r.package_id
    where r.event_date = new.requested_date
      and public.is_capacity_blocking_reservation_status(r.status)
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
  v_duration_hours integer := greatest(coalesce(p_duration_hours, 3), 1);
begin
  select coalesce(array_agg(distinct scope_value order by scope_value), '{}'::text[])
  into v_occupied_scopes
  from (
    select coalesce(r.booking_scope, public.normalize_booking_scope(r.location_type, p.package_name)) as scope_value
    from public.reservations r
    left join public.package p on p.package_id = r.package_id
    where r.event_date = p_event_date
      and public.is_capacity_blocking_reservation_status(r.status)
      and (p_exclude_reservation_id is null or r.reservation_id <> p_exclude_reservation_id)
  ) scopes
  where scope_value is not null;

  v_scope_taken := p_scope is not null and p_scope = any(v_occupied_scopes);

  if v_scope_taken then
    v_blocked_times := array[
      '1:00 PM', '2:00 PM', '3:00 PM', '4:00 PM', '5:00 PM',
      '6:00 PM', '7:00 PM', '8:00 PM', '9:00 PM', '10:00 PM'
    ];
  elsif p_scope is not null then
    select coalesce(array_agg(slot.time_label order by public.parse_event_time_text(slot.time_label)), '{}'::text[])
    into v_blocked_times
    from (
      select distinct slot.time_label
      from (
        values
          ('1:00 PM'), ('2:00 PM'), ('3:00 PM'), ('4:00 PM'), ('5:00 PM'),
          ('6:00 PM'), ('7:00 PM'), ('8:00 PM'), ('9:00 PM'), ('10:00 PM')
      ) as slot(time_label)
      where exists (
        select 1
        from public.reservations r
        left join public.package p on p.package_id = r.package_id
        where r.event_date = p_event_date
          and public.is_capacity_blocking_reservation_status(r.status)
          and (p_exclude_reservation_id is null or r.reservation_id <> p_exclude_reservation_id)
          and public.booking_scopes_overlap_by_time(
            p_scope,
            coalesce(r.booking_scope, public.normalize_booking_scope(r.location_type, p.package_name))
          )
          and public.booking_times_overlap(
            public.parse_event_time_text(slot.time_label),
            (
              public.parse_event_time_text(slot.time_label)
              + make_interval(hours => v_duration_hours)
            )::time,
            public.parse_event_time_text(r.event_time),
            coalesce(
              r.event_end_time,
              (
                public.parse_event_time_text(r.event_time)
                + make_interval(hours => coalesce(p.duration_hours, 3))
              )::time
            )
          )
      )
    ) slot;
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
      and public.is_capacity_blocking_reservation_status(r.status)
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

drop policy if exists "insert own completed reservation review" on public.reviews;
create policy "insert own completed reservation review"
  on public.reviews for insert
  with check (
    auth.uid() = user_id
    and exists (
      select 1
      from public.reservations r
      where r.reservation_id = reviews.reservation_id
        and r.user_id = auth.uid()
        and (
          lower(coalesce(r.status, '')) = 'completed'
          or (
            lower(coalesce(r.status, '')) in ('confirmed', 'partially_paid', 'fully_paid')
            and (
              r.event_date < timezone('Asia/Manila', now())::date
              or (
                r.event_date = timezone('Asia/Manila', now())::date
                and coalesce(
                  to_timestamp(
                    coalesce(nullif(trim(coalesce(r.event_time, '')), ''), '12:00 AM'),
                    'HH12:MI AM'
                  )::time,
                  time '00:00'
                ) <= timezone('Asia/Manila', now())::time
              )
            )
          )
        )
    )
  );
