-- Package Discounts (Phase 2 of package promos — Phase 1 was badges,
-- 20260726_package_badges.sql). Admin-configured percentage discounts on
-- packages, shown to customers as struck-through original + discounted
-- price, flowing through the existing base -> service charge -> total ->
-- deposit stack (see resolveServiceCharge()/buildSummary() in
-- js/reservations.js). Snapshotted onto reservations at booking time so a
-- later promo change never reprices an existing booking or signed contract.
--
-- Also removes the dead refund_window_days setting (payments are
-- non-refundable; confirmed nothing in the codebase branches on it).
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists public.package_discount (
  discount_id    uuid primary key default gen_random_uuid(),
  package_id     uuid not null references public.package(package_id) on delete cascade,
  percent_off    numeric(5,2) not null check (percent_off > 0 and percent_off <= 100),
  label          text,
  starts_at      timestamptz,
  ends_at        timestamptz,
  is_active      boolean not null default true,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  constraint window_order check (starts_at is null or ends_at is null or starts_at < ends_at)
);

-- At most one active discount per package at a time — two overlapping
-- discounts on one package is ambiguous ("which applies?"). Discounts are
-- deactivated when they end, never deleted, so past bookings resolve and a
-- promo can be re-run later as a fresh row.
create unique index if not exists one_active_discount_per_package
  on public.package_discount (package_id) where is_active;

alter table public.package_discount enable row level security;

create policy "Public read active discounts" on public.package_discount
  for select using (is_active = true);

create policy "Staff read all discounts" on public.package_discount
  for select using (
    exists (
      select 1 from public.profiles p
      where p.user_id = auth.uid() and p.role in ('admin', 'manager', 'staff')
    )
  );

create policy "Admin manage discounts" on public.package_discount
  for all using (get_my_role() = 'admin') with check (get_my_role() = 'admin');

-- ── Snapshot columns on reservations ────────────────────────────────────────
-- Same trust model / treatment as service_charge_percent/service_charge_amount
-- (20260817_service_charge.sql): written by the client alongside total_price
-- at booking submission, frozen from then on. Later edits to a discount only
-- affect new bookings; existing rows keep what was true when they were
-- created.
alter table public.reservations
  add column if not exists discount_percent numeric(5,2),
  add column if not exists discount_amount numeric(12,2),
  add column if not exists discount_label text;

-- ── Price-floor trigger: allow the discounted total through ────────────────
-- enforce_reservation_capacity() (20260731_reservation_package_integrity.sql)
-- rejects any total_price less than the package's list price. A legitimate
-- discounted booking's total_price is below that list price by design, so
-- the floor must subtract the same discount_amount being snapshotted above.
-- Full function body carried over unchanged except this one line.
create or replace function public.enforce_reservation_capacity()
returns trigger
language plpgsql
as $$
declare
  v_package_name text;
  v_duration_hours integer := 3;
  v_package_price numeric;
  v_package_min_guests integer;
  v_package_max_guests integer;
  v_package_is_active boolean;
  v_addon_price numeric := 0;
  v_is_catering boolean;
  v_scope text;
  v_start_time time;
  v_end_time time;
  v_scope_label text;
  v_event_label text;
begin
  select p.package_name, coalesce(p.duration_hours, 3), p.price, p.min_guests, p.max_guests, p.is_active
  into v_package_name, v_duration_hours, v_package_price, v_package_min_guests, v_package_max_guests, v_package_is_active
  from public.package p
  where p.package_id = new.package_id;

  -- ── Package integrity (Reservation Form ↔ Admin Inventory single source) ──
  if (
    tg_op = 'INSERT'
    or new.package_id is distinct from old.package_id
    or new.add_on_id is distinct from old.add_on_id
    or new.guest_count is distinct from old.guest_count
    or new.total_price is distinct from old.total_price
  ) then

    if new.package_id is null then
      raise exception using errcode = 'P0001', message = 'A package selection is required.';
    end if;

    if v_package_name is null then
      raise exception using errcode = 'P0001', message = 'Selected package could not be found.';
    end if;

    if v_package_is_active is not true then
      raise exception using errcode = 'P0001', message = 'Selected package is no longer available.';
    end if;

    if v_package_min_guests is not null and new.guest_count < v_package_min_guests then
      raise exception using errcode = 'P0001',
        message = format('Guest count must be at least %s for this package.', v_package_min_guests);
    end if;

    if v_package_max_guests is not null and new.guest_count > v_package_max_guests then
      raise exception using errcode = 'P0001',
        message = format('Guest count must be at most %s for this package.', v_package_max_guests);
    end if;

    v_is_catering := (new.location_type = 'offsite' and lower(v_package_name) like '%catering%');

    if not v_is_catering then
      v_addon_price := 0;
      if new.add_on_id is not null then
        select coalesce(p2.price, 0) into v_addon_price
        from public.package p2
        where p2.package_id = new.add_on_id;
      end if;

      if new.total_price < (coalesce(v_package_price, 0) - coalesce(new.discount_amount, 0) + coalesce(v_addon_price, 0)) then
        raise exception using errcode = 'P0001',
          message = 'Total price cannot be less than the selected package price.';
      end if;
    end if;

  end if;

  -- ── Scheduling / capacity (unchanged from the original function) ──────────
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

-- ── Cleanup: refund_window_days is dead (payments are non-refundable) ──────
-- setting_value is stored as text (JSON-encoded), per every other migration
-- that edits this blob (e.g. 20260730_reschedule_fee_centralization.sql).
update public.system_settings
  set setting_value = (setting_value::jsonb - 'refund_window_days')::text
  where setting_key = 'payment_rules';
