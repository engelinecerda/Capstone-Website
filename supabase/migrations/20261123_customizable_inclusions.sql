-- ═══════════════════════════════════════════════════════════════════════════
-- Customizable inclusions (phase 1)
--
-- Customers can uncheck optional inclusions of a package while reserving; each
-- removed inclusion lowers the package price by its "removal credit". The
-- package price stays the base:
--
--     adjusted package amount = package price - credits of removed inclusions
--     discount                = discount % x adjusted package amount
--     (additional heads, add-ons, service charge: unchanged)
--
-- What this migration adds
--   1. inclusion_catalog      reusable items (name, price, active) admins manage
--                             under Inventory -> Inclusions.
--   2. package.inclusion_options
--                             per-package inclusion configuration, jsonb array of
--                             { id, name, required, credit, catalog_id }.
--                             package.inclusions (plain text list used by every
--                             existing page) is DERIVED from it by a trigger, so
--                             old pages and cached scripts keep working. A package
--                             with no options behaves exactly as before: every
--                             inclusion is fixed and nothing can be removed.
--   3. reservations.removed_inclusion_ids / inclusion_adjustment /
--      inclusion_snapshot     what the customer removed, the frozen credit total
--                             and a frozen copy of the inclusions as booked, so
--                             later catalog or package edits never reprice or
--                             rewrite an existing booking or contract.
--   4. apply_reservation_inclusions()
--                             the server recomputes the credit from the package's
--                             own configuration (the client only says WHICH
--                             optional inclusions were removed, never how much).
--   5. enforce_reservation_capacity()
--                             re-declared with the 20261122 body and ONE change:
--                             the price floor now subtracts inclusion_adjustment.
--                             Safe to run whether or not 20261122 was applied.
-- ═══════════════════════════════════════════════════════════════════════════

-- 1. Catalog ----------------------------------------------------------------
create table if not exists public.inclusion_catalog (
  inclusion_id uuid primary key default gen_random_uuid(),
  name         text not null check (length(btrim(name)) > 0),
  price        numeric(12,2) not null default 0 check (price >= 0),
  is_active    boolean not null default true,
  sort_order   int not null default 0,
  created_at   timestamptz not null default now()
);

create unique index if not exists inclusion_catalog_name_key
  on public.inclusion_catalog (lower(btrim(name)));

alter table public.inclusion_catalog enable row level security;

drop policy if exists "Admin read inclusion_catalog" on public.inclusion_catalog;
create policy "Admin read inclusion_catalog" on public.inclusion_catalog for select using (
  exists (select 1 from public.profiles p where p.user_id = auth.uid() and p.role in ('admin','manager','staff'))
);

drop policy if exists "Admin manage inclusion_catalog" on public.inclusion_catalog;
create policy "Admin manage inclusion_catalog" on public.inclusion_catalog for all
  using (get_my_role() = 'admin') with check (get_my_role() = 'admin');

-- 2. Per-package options + derived plain list -----------------------------------
alter table public.package
  add column if not exists inclusion_options jsonb not null default '[]'::jsonb;

create or replace function public.sync_package_inclusions()
returns trigger
language plpgsql
as $$
declare
  v_elem     jsonb;
  v_ids      text[] := '{}';
  v_id       text;
  v_name     text;
  v_credit   numeric;
  v_optional numeric := 0;
begin
  if new.inclusion_options is null then
    new.inclusion_options := '[]'::jsonb;
  end if;

  if jsonb_typeof(new.inclusion_options) <> 'array' then
    raise exception using errcode = 'P0001', message = 'Inclusion options must be a list.';
  end if;

  for v_elem in select * from jsonb_array_elements(new.inclusion_options) loop
    if jsonb_typeof(v_elem) <> 'object' then
      raise exception using errcode = 'P0001', message = 'Each inclusion must be an object.';
    end if;

    v_id   := btrim(coalesce(v_elem->>'id', ''));
    v_name := btrim(coalesce(v_elem->>'name', ''));

    if v_id = '' then
      raise exception using errcode = 'P0001', message = 'Each inclusion needs an id.';
    end if;
    if v_id = any(v_ids) then
      raise exception using errcode = 'P0001', message = 'Inclusion ids must be unique within a package.';
    end if;
    v_ids := v_ids || v_id;

    if v_name = '' then
      raise exception using errcode = 'P0001', message = 'Each inclusion needs a name.';
    end if;
    if jsonb_typeof(v_elem->'required') is distinct from 'boolean' then
      raise exception using errcode = 'P0001', message = format('Inclusion "%s" must say whether it is required.', v_name);
    end if;

    if (v_elem->>'required')::boolean is false then
      begin
        v_credit := coalesce((v_elem->>'credit')::numeric, 0);
      exception when others then
        raise exception using errcode = 'P0001', message = format('Inclusion "%s" has an invalid removal credit.', v_name);
      end;
      if v_credit < 0 then
        raise exception using errcode = 'P0001', message = format('Inclusion "%s" cannot have a negative removal credit.', v_name);
      end if;
      v_optional := v_optional + v_credit;
    end if;
  end loop;

  if v_optional > coalesce(new.price, 0) then
    raise exception using errcode = 'P0001',
      message = format('Optional inclusion credits (%s) cannot add up to more than the package price (%s).', v_optional, coalesce(new.price, 0));
  end if;

  -- The plain list every existing page reads is derived from the options, so
  -- there is one place to edit and the two can never drift apart.
  if jsonb_array_length(new.inclusion_options) > 0 then
    select coalesce(jsonb_agg(btrim(t.e->>'name') order by t.ord), '[]'::jsonb)
    into new.inclusions
    from jsonb_array_elements(new.inclusion_options) with ordinality as t(e, ord);
  end if;

  return new;
end;
$$;

drop trigger if exists package_sync_inclusions on public.package;
create trigger package_sync_inclusions
  before insert or update of inclusion_options, price on public.package
  for each row execute function public.sync_package_inclusions();

-- 3. Reservation columns ----------------------------------------------------------
alter table public.reservations
  add column if not exists removed_inclusion_ids jsonb not null default '[]'::jsonb,
  add column if not exists inclusion_adjustment  numeric(12,2) not null default 0,
  add column if not exists inclusion_snapshot    jsonb;

-- 4. Server-side recompute --------------------------------------------------------
-- Named so it fires BEFORE reservations_enforce_capacity (BEFORE triggers run
-- alphabetically): the price floor in that function reads inclusion_adjustment.
create or replace function public.apply_reservation_inclusions()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_options  jsonb;
  v_removed  jsonb;
  v_ids      text[];
  v_bad      text;
  v_credit   numeric := 0;
  v_snapshot jsonb;
begin
  -- After the booking exists its inclusion figures are frozen: a status change
  -- or reschedule must not recompute them, and nobody can edit the frozen
  -- columns directly.
  if tg_op = 'UPDATE'
     and new.package_id is not distinct from old.package_id
     and new.removed_inclusion_ids is not distinct from old.removed_inclusion_ids then
    new.inclusion_adjustment := old.inclusion_adjustment;
    new.inclusion_snapshot   := old.inclusion_snapshot;
    return new;
  end if;

  v_removed := coalesce(new.removed_inclusion_ids, '[]'::jsonb);
  if jsonb_typeof(v_removed) <> 'array' then
    raise exception using errcode = 'P0001', message = 'The list of removed inclusions is invalid.';
  end if;
  new.removed_inclusion_ids := v_removed;

  select coalesce(array_agg(distinct btrim(x)), '{}')
  into v_ids
  from jsonb_array_elements_text(v_removed) as x;

  select p.inclusion_options into v_options
  from public.package p where p.package_id = new.package_id;

  if v_options is null or jsonb_array_length(v_options) = 0 then
    if coalesce(array_length(v_ids, 1), 0) > 0 then
      raise exception using errcode = 'P0001', message = 'Inclusions cannot be removed from this package.';
    end if;
    new.inclusion_adjustment := 0;
    new.inclusion_snapshot   := null;
    return new;
  end if;

  -- Every removed id must be an OPTIONAL inclusion of this very package.
  select r into v_bad
  from unnest(v_ids) as r
  where not exists (
    select 1 from jsonb_array_elements(v_options) e
    where e->>'id' = r and (e->>'required')::boolean is false
  )
  limit 1;
  if v_bad is not null then
    raise exception using errcode = 'P0001',
      message = 'One of the removed inclusions is required or is not part of this package.';
  end if;

  select coalesce(sum(coalesce((e->>'credit')::numeric, 0)), 0)
  into v_credit
  from jsonb_array_elements(v_options) e
  where e->>'id' = any(v_ids);

  select jsonb_agg(
           jsonb_build_object(
             'id',       e->>'id',
             'name',     e->>'name',
             'required', (e->>'required')::boolean,
             'credit',   case when (e->>'required')::boolean then 0 else coalesce((e->>'credit')::numeric, 0) end,
             'removed',  (e->>'id') = any(v_ids)
           ) order by t.ord)
  into v_snapshot
  from jsonb_array_elements(v_options) with ordinality as t(e, ord);

  new.inclusion_adjustment := v_credit;
  new.inclusion_snapshot   := v_snapshot;
  return new;
end;
$$;

drop trigger if exists reservations_apply_inclusions on public.reservations;
create trigger reservations_apply_inclusions
  before insert or update on public.reservations
  for each row execute function public.apply_reservation_inclusions();

-- 5. Price floor subtracts the removal credits -------------------------------------
create or replace function public.enforce_reservation_capacity()
returns trigger
language plpgsql
as $$
declare
  v_package_name text;
  v_package_location_type text;
  v_package_scopes text[];
  v_duration_hours integer := 3;
  v_package_price numeric;
  v_package_min_guests integer;
  v_package_max_guests integer;
  v_package_is_active boolean;
  v_addon_price numeric := 0;
  v_is_catering boolean;
  v_scopes text[];
  v_single_scope text;
  v_start_time time;
  v_end_time time;
  v_scope_label text;
  v_event_label text;
  v_capacity integer := 2;
  v_scope_override integer;
  v_daily_count integer;
  v_held_daily_count integer;
  v_held_conflict boolean;
  v_approved_extension_hours numeric := 0;
  v_approved_post_booking_heads integer := 0;
  v_rules_json jsonb;
  v_min_advance_days integer := 14;
  v_max_advance_days integer := 365;
  v_advance_event_type_override integer;
  v_days_until integer;
  v_venue_id uuid;
  v_venue_count integer;
  v_venue_capacity_override integer;
  v_venue_name text;
  v_venue_conflict boolean;
  v_allow_additional_head boolean;
  v_price_per_additional_head numeric;
  v_max_additional_heads integer;
  v_venue_capacity integer;
  v_combo_capacity integer;
  v_room_scope text;
begin
  select p.package_name, p.location_type, p.booking_scope, coalesce(p.duration_hours, 3), p.price, p.min_guests, p.max_guests, p.is_active
  into v_package_name, v_package_location_type, v_package_scopes, v_duration_hours, v_package_price, v_package_min_guests, v_package_max_guests, v_package_is_active
  from public.package p
  where p.package_id = new.package_id;

  -- Additional Per-Head (post-booking): self-heal additional_heads from
  -- base_additional_heads + every APPROVED post-booking request, before
  -- anything downstream reads it. base_additional_heads itself is only
  -- ever set at true INSERT (from whatever the client submitted at
  -- booking) and never touched again afterward.
  if tg_op = 'INSERT' then
    new.base_additional_heads := coalesce(new.additional_heads, 0);
  end if;

  if new.reservation_id is not null then
    select coalesce(sum(rah.requested_heads), 0)
    into v_approved_post_booking_heads
    from public.reservation_additional_head_requests rah
    where rah.reservation_id = new.reservation_id
      and rah.status = 'approved';
  else
    v_approved_post_booking_heads := 0;
  end if;
  new.additional_heads := coalesce(new.base_additional_heads, 0) + v_approved_post_booking_heads;

  -- ── Package integrity (Reservation Form ↔ Admin Inventory single source) ──
  if (
    tg_op = 'INSERT'
    or new.package_id is distinct from old.package_id
    or new.add_on_id is distinct from old.add_on_id
    or new.guest_count is distinct from old.guest_count
    or new.additional_heads is distinct from old.additional_heads
    or new.total_price is distinct from old.total_price
    or new.location_type is distinct from old.location_type
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

    -- A package configured as onsite-only or offsite-only cannot be booked
    -- under the other location type. 'both' packages are valid either way.
    if v_package_location_type is not null
       and v_package_location_type <> 'both'
       and v_package_location_type is distinct from new.location_type then
      raise exception using errcode = 'P0001',
        message = 'Selected package is not available for the chosen location type.';
    end if;

    if v_package_min_guests is not null and new.guest_count < v_package_min_guests then
      raise exception using errcode = 'P0001',
        message = format('Guest count must be at least %s for this package.', v_package_min_guests);
    end if;

    -- Additional Per-Head: guest_count above max_guests is only ever valid
    -- when it's backed by additional_heads (allow-flag, cap, and — for
    -- onsite — venue capacity are all validated further below, once the
    -- venue is resolved). Recompute guest_count from the package ceiling +
    -- additional_heads here so it can never drift from what was actually
    -- charged for — the same "server always recomputes, never trusts the
    -- client's math" rule this function already applies to booking_scope/
    -- venue_id/event_end_time. When no additional heads are requested,
    -- behavior is completely unchanged from before this feature existed.
    if coalesce(new.additional_heads, 0) > 0 then
      new.guest_count := coalesce(v_package_max_guests, new.guest_count) + new.additional_heads;
    elsif v_package_max_guests is not null and new.guest_count > v_package_max_guests then
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

      -- Customizable inclusions: the credits of the optional inclusions the
      -- customer removed (inclusion_adjustment, recomputed from the package's
      -- own configuration by apply_reservation_inclusions()) lower the floor.
      if new.total_price < (coalesce(v_package_price, 0) - coalesce(new.inclusion_adjustment, 0) - coalesce(new.discount_amount, 0) + coalesce(v_addon_price, 0)) then
        raise exception using errcode = 'P0001',
          message = 'Total price cannot be less than the selected package price.';
      end if;
    end if;

  end if;

  -- ── BUG-02 fix: server-side advance-notice window, same source/shape as
  -- enforce_reschedule_capacity()'s existing check ──────────────────────────
  if new.event_date is not null and (tg_op = 'INSERT' or new.event_date is distinct from old.event_date) then
    select ss.setting_value::jsonb into v_rules_json
    from public.system_settings ss
    where ss.setting_key = 'reservation_rules';

    v_min_advance_days := coalesce((v_rules_json->>'min_advance_days')::integer, 14);
    v_max_advance_days := coalesce((v_rules_json->>'max_advance_days')::integer, 365);

    select et.min_advance_days into v_advance_event_type_override
    from public.event_types et
    where et.name = new.event_type;

    v_min_advance_days := coalesce(v_advance_event_type_override, v_min_advance_days);

    v_days_until := new.event_date - current_date;

    if v_days_until < v_min_advance_days then
      raise exception using
        errcode = 'P0001',
        message = 'This date is too soon — please choose a date at least ' || v_min_advance_days || ' day(s) from today.';
    end if;

    if v_days_until > v_max_advance_days then
      raise exception using
        errcode = 'P0001',
        message = 'This date is too far in advance — please choose a date within ' || v_max_advance_days || ' day(s) from today.';
    end if;
  end if;

  -- ── Scheduling / capacity ──────────
  v_scopes := coalesce(v_package_scopes, array[public.normalize_booking_scope(new.location_type, v_package_name)]);
  new.booking_scope := v_scopes;

  -- ── Venue resolution ────────────────────────────────────────────────────
  -- Only single-scope packages get a resolved venue — a combo (2-scope)
  -- package keeps venue_id null and falls through to pure scope checks
  -- below, same as a package with zero mapped venues.
  v_venue_id := null;
  -- A room is only ever resolved for an onsite booking: an offsite booking of a
  -- package that also lists rooms must not pick one up.
  if v_scopes is not null and array_length(v_scopes, 1) = 1 and new.location_type is distinct from 'offsite' then
    select count(*) into v_venue_count
    from public.package_venue pv
    join public.venue v on v.venue_id = pv.venue_id and v.is_active
    where pv.package_id = new.package_id;

    if new.venue_id is not null then
      -- Client supplied one (multi-venue package) — validate it's actually
      -- one of this package's mapped, active venues rather than trusting it.
      if not exists (
        select 1 from public.package_venue pv
        join public.venue v on v.venue_id = pv.venue_id and v.is_active
        where pv.package_id = new.package_id and pv.venue_id = new.venue_id
      ) then
        raise exception using errcode = 'P0001',
          message = 'Selected venue is not available for this package.';
      end if;
      v_venue_id := new.venue_id;
    elsif v_venue_count = 1 then
      -- Exactly one candidate — resolve it automatically, no client choice needed.
      select pv.venue_id into v_venue_id
      from public.package_venue pv
      join public.venue v on v.venue_id = pv.venue_id and v.is_active
      where pv.package_id = new.package_id;
    end if;
    -- v_venue_count = 0 or > 1 with no client selection: v_venue_id stays
    -- null, falls back to scope-only checks below (matches today exactly).
  end if;
  new.venue_id := v_venue_id;

  -- Where an onsite booking physically is decides which scope it occupies. A
  -- package listed for both onsite and offsite (e.g. All-Occasion Standard 50
  -- Pax, which carries the offsite scope) is booked into VIP Lounge or Main
  -- Hall, and every scope-based check (the calendar, rescheduling, bookings
  -- with no room) has to see it there, not as an offsite event.
  if new.location_type = 'onsite' and v_venue_id is not null then
    select v.booking_scope into v_room_scope
    from public.venue v
    where v.venue_id = v_venue_id;

    if v_room_scope is not null then
      v_scopes := array[v_room_scope];
      new.booking_scope := v_scopes;
    end if;
  end if;

  -- ── Additional Per-Head: allow-flag, cap, price, and (onsite only) venue
  -- capacity — placed here so the already-resolved v_venue_id is available.
  -- Same guard as the package-integrity block above (v_is_catering/
  -- v_addon_price, set there, are always fresh whenever this one runs too).
  if (
    tg_op = 'INSERT'
    or new.package_id is distinct from old.package_id
    or new.add_on_id is distinct from old.add_on_id
    or new.guest_count is distinct from old.guest_count
    or new.additional_heads is distinct from old.additional_heads
    or new.total_price is distinct from old.total_price
    or new.location_type is distinct from old.location_type
  ) then
    select p.allow_additional_head, p.price_per_additional_head, p.max_additional_heads
    into v_allow_additional_head, v_price_per_additional_head, v_max_additional_heads
    from public.package p
    where p.package_id = new.package_id;

    if coalesce(new.additional_heads, 0) > 0 then
      if not coalesce(v_allow_additional_head, false) then
        raise exception using errcode = 'P0001',
          message = 'Selected package does not allow additional guests.';
      end if;

      if v_price_per_additional_head is null then
        raise exception using errcode = 'P0001',
          message = 'This package is not configured for additional guests.';
      end if;

      if v_max_additional_heads is not null and new.additional_heads > v_max_additional_heads then
        raise exception using errcode = 'P0001',
          message = format('This package allows at most %s additional guest(s).', v_max_additional_heads);
      end if;

      -- Onsite: total guests must fit the venue. A single-room package is
      -- checked against its resolved room. A combo package (2+ scopes —
      -- never gets a venue_id, since it occupies several rooms at once) is
      -- checked against the COMBINED capacity of every active room mapped
      -- to it. Anything still unresolved, or a combo with no mapped room
      -- capacity to size against, fails closed here rather than booking an
      -- unchecked headcount.
      if new.location_type = 'onsite' then
        if v_venue_id is null and coalesce(array_length(v_scopes, 1), 0) > 1 then
          select sum(v.capacity) into v_combo_capacity
          from public.package_venue pv
          join public.venue v on v.venue_id = pv.venue_id and v.is_active
          where pv.package_id = new.package_id
            and v.capacity is not null;

          if v_combo_capacity is null then
            raise exception using errcode = 'P0001',
              message = 'Could not verify venue capacity for additional guests — this package has no rooms with a set capacity.';
          end if;

          if new.guest_count > v_combo_capacity then
            raise exception using errcode = 'P0001',
              message = format('This package holds %s guests across its rooms — you can add at most %s additional guest(s).',
                v_combo_capacity,
                greatest(v_combo_capacity - coalesce(v_package_max_guests, 0), 0));
          end if;
        else
          if v_venue_id is null then
            raise exception using errcode = 'P0001',
              message = 'Could not verify venue capacity for additional guests — please reselect your room.';
          end if;

          select v.capacity, v.name into v_venue_capacity, v_venue_name
          from public.venue v where v.venue_id = v_venue_id;

          if v_venue_capacity is not null and new.guest_count > v_venue_capacity then
            raise exception using errcode = 'P0001',
              message = format('%s holds %s guests — you can add at most %s additional guest(s).',
                coalesce(v_venue_name, 'The selected venue'),
                v_venue_capacity,
                greatest(v_venue_capacity - coalesce(v_package_max_guests, 0), 0));
          end if;
        end if;
      end if;
      -- Offsite: no venue, no capacity check — per spec, capped only by
      -- max_additional_heads (already enforced above).

      -- Frozen at booking time — only (re)snapshotted on a true INSERT or a
      -- genuine change to the INITIAL booking-time count, never on an
      -- update that only moved the cumulative total via an approved
      -- post-booking request (see this section's own header note).
      if tg_op = 'INSERT' or new.base_additional_heads is distinct from old.base_additional_heads then
        new.additional_head_price  := v_price_per_additional_head;
        new.additional_head_charge := coalesce(new.base_additional_heads, 0) * v_price_per_additional_head;
      end if;
    else
      new.base_additional_heads  := 0;
      new.additional_head_price  := null;
      new.additional_head_charge := 0;
    end if;

    -- Extends the price-floor check above with the additional-head charge —
    -- same floor, one more term, same catering exemption (no single
    -- package.price to floor a cart-priced booking against). Always uses
    -- the frozen INITIAL charge (never the cumulative one), matching how
    -- total_price itself is never touched by an approved post-booking
    -- request.
    if not v_is_catering and new.total_price < (
      coalesce(v_package_price, 0) - coalesce(new.inclusion_adjustment, 0) - coalesce(new.discount_amount, 0)
      + coalesce(v_addon_price, 0) + coalesce(new.additional_head_charge, 0)
    ) then
      raise exception using errcode = 'P0001',
        message = 'Total price cannot be less than the selected package price plus any additional guest charge.';
    end if;
  end if;

  v_start_time := public.parse_event_time_text(new.event_time);

  -- Extension Hours: fold in every APPROVED extension's hours so
  -- event_end_time always reflects the reservation's true effective end
  -- time, regardless of what triggered this recompute.
  if new.reservation_id is not null then
    select coalesce(sum(re.requested_hours), 0)
    into v_approved_extension_hours
    from public.reservation_extensions re
    where re.reservation_id = new.reservation_id
      and re.status = 'approved';
  end if;

  if v_start_time is not null and coalesce(v_duration_hours, 0) > 0 then
    v_end_time := (v_start_time + make_interval(hours => v_duration_hours) + make_interval(secs => coalesce(v_approved_extension_hours, 0) * 3600))::time;
  else
    v_end_time := null;
  end if;
  new.event_end_time := v_end_time;

  -- This row's own status still needs to reach the checks below while
  -- pending (so its scope/end-time are stored, and it's still rejected if
  -- it genuinely overlaps something already approved) — 'pending' stays in
  -- this gate. What changes below is which OTHER rows' statuses count as
  -- blocking (BUG-01 fix).
  if lower(coalesce(new.status, '')) not in ('pending', 'approved', 'confirmed', 'rescheduled') then
    return new;
  end if;

  if new.event_date is null or v_scopes is null or array_length(v_scopes, 1) is null then
    return new;
  end if;

  -- Held-hold conflicts (reschedule/extension) are still checked one scope
  -- at a time — count_held_reschedule_conflicts()/count_held_extension_
  -- conflicts() take a single scope by design, called once per element of
  -- this reservation's set instead of teaching them a second, array-typed
  -- signature. Left scope-level even once venues are in play (see header).
  v_held_conflict := false;
  foreach v_single_scope in array v_scopes loop
    if public.count_held_reschedule_conflicts(
      new.event_date, v_single_scope, v_start_time, v_end_time, 0,
      coalesce(new.reservation_id, '00000000-0000-0000-0000-000000000000'::uuid)
    ) > 0 or public.count_held_extension_conflicts(
      new.event_date, v_single_scope, v_start_time, v_end_time, 0,
      coalesce(new.reservation_id, '00000000-0000-0000-0000-000000000000'::uuid)
    ) > 0 then
      v_held_conflict := true;
      exit;
    end if;
  end loop;

  -- Venue-aware overlap: two reservations only conflict on venue grounds
  -- when BOTH have a resolved venue_id and it's the same one; otherwise
  -- (either side unresolved) fall back to the original scope-overlap
  -- check, which never under-blocks a real conflict.
  select exists (
    select 1
    from public.reservations r
    left join public.package rp on rp.package_id = r.package_id
    where r.event_date = new.event_date
      and lower(coalesce(r.status, '')) in ('approved', 'confirmed', 'rescheduled')
      and r.reservation_id <> coalesce(new.reservation_id, '00000000-0000-0000-0000-000000000000'::uuid)
      and (
        (v_venue_id is not null and r.venue_id is not null and r.venue_id = v_venue_id)
        or (
          not (v_venue_id is not null and r.venue_id is not null)
          and coalesce(r.booking_scope, array[public.normalize_booking_scope(r.location_type, rp.package_name)]) && v_scopes
        )
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
  ) into v_venue_conflict;

  if v_venue_conflict or v_held_conflict then
    raise exception using
      errcode = 'P0001',
      message = 'This reservation overlaps an existing booking for the selected date and scope.';
  end if;

  -- Daily capacity cap. When a venue is resolved, check that venue's own
  -- daily count/limit only (skipping its scope's cap, since the venue-level
  -- check is strictly more specific). Otherwise, walk every scope in this
  -- reservation's set exactly as before.
  v_event_label := to_char(new.event_date::timestamp, 'FMMonth DD, YYYY');

  if v_venue_id is not null then
    select default_slot_capacity
    into v_capacity
    from public.scheduling_settings where id = true;
    v_capacity := coalesce(v_capacity, 2);

    select capacity into v_venue_capacity_override from public.venue_capacity where venue_id = v_venue_id;
    v_capacity := coalesce(v_venue_capacity_override, v_capacity);

    -- Bookings with no room recorded (a combo package, or one made before
    -- rooms existed) occupy the whole scope, so they count toward this room's
    -- daily limit too. v_scopes is this room's single scope here.
    select count(*)
    into v_daily_count
    from public.reservations r
    left join public.package rp on rp.package_id = r.package_id
    where r.event_date = new.event_date
      and lower(coalesce(r.status, '')) in ('approved', 'confirmed', 'rescheduled')
      and (
        r.venue_id = v_venue_id
        or (
          r.venue_id is null
          and coalesce(r.booking_scope, array[public.normalize_booking_scope(r.location_type, rp.package_name)]) && v_scopes
        )
      )
      and r.reservation_id <> coalesce(new.reservation_id, '00000000-0000-0000-0000-000000000000'::uuid);

    if coalesce(v_daily_count, 0) >= v_capacity then
      select v.name into v_venue_name from public.venue v where v.venue_id = v_venue_id;
      raise exception using
        errcode = 'P0001',
        message = coalesce(v_venue_name, 'Selected venue') || ' has reached its daily booking limit for ' || v_event_label || '.';
    end if;
  else
    foreach v_single_scope in array v_scopes loop
      select default_slot_capacity
      into v_capacity
      from public.scheduling_settings where id = true;
      v_capacity := coalesce(v_capacity, 2);

      select capacity into v_scope_override from public.scope_capacity where scope = v_single_scope;
      v_capacity := coalesce(v_scope_override, v_capacity);

      select count(*)
      into v_daily_count
      from public.reservations r
      left join public.package rp on rp.package_id = r.package_id
      where r.event_date = new.event_date
        and lower(coalesce(r.status, '')) in ('approved', 'confirmed', 'rescheduled')
        and v_single_scope = any(coalesce(r.booking_scope, array[public.normalize_booking_scope(r.location_type, rp.package_name)]))
        and r.reservation_id <> coalesce(new.reservation_id, '00000000-0000-0000-0000-000000000000'::uuid);

      v_held_daily_count := public.count_held_reschedule_conflicts(
        new.event_date, v_single_scope, null, null, 0,
        coalesce(new.reservation_id, '00000000-0000-0000-0000-000000000000'::uuid)
      );

      if coalesce(v_daily_count, 0) + coalesce(v_held_daily_count, 0) >= v_capacity then
        v_scope_label := case v_single_scope
          when 'onsite_vip' then 'VIP'
          when 'onsite_main_hall' then 'Main Hall'
          when 'offsite' then 'Off-site'
          else 'Selected'
        end;

        raise exception using
          errcode = 'P0001',
          message = v_scope_label || ' has reached its daily booking limit for ' || v_event_label || '.';
      end if;
    end loop;
  end if;

  return new;
end;
$$;

alter function public.enforce_reservation_capacity() security definer set search_path = public;
