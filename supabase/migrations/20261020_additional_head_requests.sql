-- Additional Head Requests — post-booking counterpart to Additional Per-Head
-- (20261018_additional_per_head.sql), which only ever let a customer choose
-- extra guests once, on the initial booking form. This migration adds the
-- ability to request MORE guests on an ALREADY-CONFIRMED reservation,
-- mirroring the Package Extension Hours feature (20260920_package_
-- extension_hours.sql) as closely as possible per explicit instruction: a
-- request holds a claim on the extra headcount, the customer pays a fee,
-- a Manager approves/rejects via the SAME generic payment-review action
-- already used for every other payment type, approval finalizes the
-- change in place, and an unpaid hold expires automatically.
--
-- What's genuinely different from Extension Hours, and why:
--   - An extension hold blocks a TIME RANGE another reservation could also
--     want (hence count_held_extension_conflicts()). An additional-head
--     hold blocks nothing another reservation could want — a venue's
--     capacity is a PER-EVENT ceiling (one event occupies the room at a
--     time; a second event that day uses a different time slot and gets
--     its own fresh capacity check), so there is no cross-reservation
--     contention to guard against here. This feature therefore has no
--     count_held_*_conflicts() analog at all.
--   - Extension approval extends reservations.event_end_time directly and
--     tracks its own money entirely through payment.extension_fee rows,
--     never touching reservations.total_price. This mirrors that exactly:
--     approval increments reservations.additional_heads/guest_count in
--     place and is tracked via payment.additional_head_fee rows, never
--     reservations.total_price — the INITIAL booking's own additional-head
--     charge (reservations.additional_head_price/additional_head_charge,
--     20261018) stays frozen exactly as documented there; a later
--     post-booking request is a separate, separately-paid line, not a
--     repricing of the original booking.
--   - reservations.additional_heads must therefore become a CUMULATIVE,
--     self-healing total (base + every approved post-booking request) —
--     see the new base_additional_heads column and the enforce_reservation_
--     capacity() rewrite below, same self-healing reasoning event_end_time
--     already gets from approved extensions.
-- ═══════════════════════════════════════════════════════════════════════════

-- ============================================================
-- 1. reservation_additional_head_requests
-- ============================================================
create table if not exists public.reservation_additional_head_requests (
  additional_head_request_id uuid primary key default gen_random_uuid(),
  reservation_id    uuid not null references public.reservations(reservation_id) on delete cascade,
  requested_heads   int not null check (requested_heads > 0),
  price_per_head    numeric(12,2) not null,
  total_price       numeric(12,2) not null,
  -- Same lifecycle as reservation_extensions.status, see that table's own
  -- comment for the meaning of each value.
  status            text not null default 'pending_payment'
                       check (status in ('pending_payment', 'pending_verification', 'approved', 'rejected', 'expired')),
  hold_expires_at   timestamptz,
  requested_at      timestamptz not null default now(),
  decided_at        timestamptz,
  decided_by        uuid references auth.users(id) on delete set null,
  rejection_reason  text,
  payment_id        uuid,
  created_at        timestamptz not null default now()
);

create index if not exists reservation_additional_head_requests_reservation_id_idx
  on public.reservation_additional_head_requests (reservation_id);

create index if not exists reservation_additional_head_requests_pending_hold_idx
  on public.reservation_additional_head_requests (status, hold_expires_at)
  where status = 'pending_payment';

-- payment.additional_head_request_id first (payment already exists), then
-- the reverse FK — same two-step order as extension_id, because the two
-- tables reference each other.
alter table public.payment
  add column if not exists additional_head_request_id uuid
    references public.reservation_additional_head_requests(additional_head_request_id) on delete set null;

alter table public.reservation_additional_head_requests
  drop constraint if exists reservation_additional_head_requests_payment_id_fkey;
alter table public.reservation_additional_head_requests
  add constraint reservation_additional_head_requests_payment_id_fkey
  foreign key (payment_id) references public.payment(payment_id) on delete set null;

-- 'additional_head_fee' joins the seven payment_type values already
-- enforced here as an eighth penalty/change-fee type, same reasoning as
-- extension_fee alongside it.
alter table public.payment drop constraint if exists payment_payment_type_check;
alter table public.payment add constraint payment_payment_type_check
  check (payment_type in (
    'reservation_fee',
    'down_payment',
    'full_payment',
    'partial_payment',
    'reschedule_fee',
    'cancellation_fee',
    'extension_fee',
    'additional_head_fee'
  ));

-- Immutable snapshot of what was chosen at INITIAL booking time (set once,
-- at INSERT, from the client's own additional_heads payload — no client
-- code ever includes it in an UPDATE afterward). reservations.additional_
-- heads itself becomes base_additional_heads + every APPROVED post-booking
-- request's requested_heads, self-healed on every enforce_reservation_
-- capacity() firing below. Existing rows all predate this feature, so their
-- current additional_heads value already IS exactly what was chosen at
-- booking — straight backfill, no ambiguity.
alter table public.reservations
  add column if not exists base_additional_heads int not null default 0 check (base_additional_heads >= 0);

update public.reservations
set base_additional_heads = additional_heads
where additional_heads > 0 and base_additional_heads = 0;

-- ── RLS ──────────────────────────────────────────────────────────────────
-- No UPDATE/DELETE policy for any role — identical reasoning to
-- reservation_extensions: every status transition happens inside a
-- SECURITY DEFINER trigger/cron function below.
alter table public.reservation_additional_head_requests enable row level security;

drop policy if exists "customer_select_own_additional_head_requests" on public.reservation_additional_head_requests;
create policy "customer_select_own_additional_head_requests"
  on public.reservation_additional_head_requests for select
  using (
    exists (
      select 1 from public.reservations r
      where r.reservation_id = reservation_additional_head_requests.reservation_id
        and r.user_id = auth.uid()
    )
  );

drop policy if exists "staff_select_all_additional_head_requests" on public.reservation_additional_head_requests;
create policy "staff_select_all_additional_head_requests"
  on public.reservation_additional_head_requests for select
  using (get_my_role() in ('manager', 'admin', 'staff'));

drop policy if exists "customer_insert_own_additional_head_request" on public.reservation_additional_head_requests;
create policy "customer_insert_own_additional_head_request"
  on public.reservation_additional_head_requests for insert
  with check (
    exists (
      select 1 from public.reservations r
      where r.reservation_id = reservation_additional_head_requests.reservation_id
        and r.user_id = auth.uid()
    )
  );

grant select, insert on public.reservation_additional_head_requests to authenticated;

-- ============================================================
-- 2. get_additional_head_availability() — the ONE place "how many more
--    guests can this reservation add right now" is computed. Unlike
--    get_extension_availability()'s next-booking-time search, there is no
--    cross-reservation contention to search for (see header note) — this
--    only ever compares against this reservation's OWN package cap and
--    (onsite only) its own venue's capacity, both minus whatever is
--    already on the reservation (base + already-approved requests).
--    999999 is used as a practical "no cap configured" sentinel so the
--    package-cap and venue-cap legs can be combined with a plain least()
--    without a null-handling special case at every call site — mirrors
--    how the client already treats Infinity for "unlimited" in
--    js/reservations.js's getAdditionalHeadEffectiveMax() (20261018).
-- ============================================================
create or replace function public.get_additional_head_availability(p_reservation_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_reservation      public.reservations%rowtype;
  v_package          public.package%rowtype;
  v_current_heads    integer;
  v_venue_capacity   integer;
  v_max_by_package   integer;
  v_max_by_venue     integer;
  v_max_more         integer;
begin
  select * into v_reservation from public.reservations where reservation_id = p_reservation_id;
  if v_reservation.reservation_id is null then
    return jsonb_build_object('max_additional', 0, 'price_per_head', null, 'extendable', false, 'current_additional_heads', 0);
  end if;

  select * into v_package from public.package p where p.package_id = v_reservation.package_id;
  v_current_heads := coalesce(v_reservation.additional_heads, 0);

  if not coalesce(v_package.allow_additional_head, false)
     or v_package.price_per_additional_head is null
     or not (coalesce(v_reservation.status, '') in ('approved', 'confirmed', 'rescheduled')) then
    return jsonb_build_object(
      'max_additional', 0,
      'price_per_head', v_package.price_per_additional_head,
      'extendable', false,
      'current_additional_heads', v_current_heads
    );
  end if;

  v_max_by_package := case when v_package.max_additional_heads is not null
    then greatest(v_package.max_additional_heads - v_current_heads, 0)
    else null end;

  if v_reservation.location_type = 'onsite' then
    -- No resolved venue (e.g. a combo package — see 20261018's own note):
    -- fails closed, same as the booking-time validation does.
    if v_reservation.venue_id is null then
      return jsonb_build_object(
        'max_additional', 0,
        'price_per_head', v_package.price_per_additional_head,
        'extendable', false,
        'current_additional_heads', v_current_heads
      );
    end if;

    select capacity into v_venue_capacity from public.venue where venue_id = v_reservation.venue_id;
    v_max_by_venue := greatest(coalesce(v_venue_capacity, 0) - coalesce(v_package.max_guests, 0) - v_current_heads, 0);
  else
    v_max_by_venue := null;
  end if;

  v_max_more := least(coalesce(v_max_by_package, 999999), coalesce(v_max_by_venue, 999999));

  return jsonb_build_object(
    'max_additional', v_max_more,
    'price_per_head', v_package.price_per_additional_head,
    'extendable', v_max_more > 0,
    'current_additional_heads', v_current_heads
  );
end;
$$;

create or replace function public.get_max_additional_heads(p_reservation_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_owner_id uuid;
begin
  select user_id into v_owner_id from public.reservations where reservation_id = p_reservation_id;
  if v_owner_id is null then
    raise exception using errcode = 'P0001', message = 'Reservation not found.';
  end if;

  if auth.uid() is distinct from v_owner_id and public.get_my_role() not in ('manager', 'admin', 'staff') then
    raise exception using errcode = 'P0001', message = 'Not authorized.';
  end if;

  return public.get_additional_head_availability(p_reservation_id);
end;
$$;

grant execute on function public.get_max_additional_heads(uuid) to authenticated;

-- ============================================================
-- 3. Request-time trigger — server-side authority mirroring
--    set_extension_request_defaults() exactly: eligible-status check, no
--    other request already open, requested_heads never exceeds the real
--    availability (re-derived here, never trusted from the client), price
--    snapshotted from package.price_per_additional_head ONCE, hold expiry
--    stamped from the server clock using a dedicated payment_rules key
--    (additional_head_hold_minutes, default 45 — same default as
--    extension_hold_minutes, kept as a separate key since the two holds
--    are conceptually independent and may need different windows later).
-- ============================================================
create or replace function public.set_additional_head_request_defaults()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_reservation  public.reservations%rowtype;
  v_availability jsonb;
  v_rules_json   jsonb;
  v_hold_minutes numeric := 45;
begin
  select * into v_reservation from public.reservations where reservation_id = new.reservation_id;
  if v_reservation.reservation_id is null then
    raise exception using errcode = 'P0001', message = 'Reservation not found.';
  end if;

  if not (v_reservation.status in ('approved', 'confirmed', 'rescheduled')) then
    raise exception using errcode = 'P0001', message = 'This reservation is not yet eligible for an additional guests request.';
  end if;

  -- Only one open request at a time per reservation — mirrors
  -- set_extension_request_defaults()'s identical guard.
  if exists (
    select 1 from public.reservation_additional_head_requests existing
    where existing.reservation_id = new.reservation_id
      and (
        existing.status = 'pending_verification'
        or (existing.status = 'pending_payment' and existing.hold_expires_at > now())
      )
  ) then
    raise exception using
      errcode = 'P0001',
      message = 'You already have an open additional guests request for this reservation — wait for it to be resolved before requesting another.';
  end if;

  if new.requested_heads <> floor(new.requested_heads) or new.requested_heads <= 0 then
    raise exception using errcode = 'P0001', message = 'Please request a whole number of additional guests.';
  end if;

  v_availability := public.get_additional_head_availability(new.reservation_id);

  if not (v_availability->>'extendable')::boolean then
    raise exception using errcode = 'P0001', message = 'Additional guests cannot be requested for this reservation right now.';
  end if;

  if new.requested_heads > (v_availability->>'max_additional')::numeric then
    raise exception using
      errcode = 'P0001',
      message = format('You can add up to %s more guest(s) right now.', (v_availability->>'max_additional')::numeric);
  end if;

  select ss.setting_value::jsonb into v_rules_json
  from public.system_settings ss
  where ss.setting_key = 'payment_rules';
  v_hold_minutes := coalesce((v_rules_json->>'additional_head_hold_minutes')::numeric, 45);

  new.price_per_head   := (v_availability->>'price_per_head')::numeric;
  new.total_price      := round(new.requested_heads * new.price_per_head, 2);
  new.status           := 'pending_payment';
  new.requested_at     := now();
  new.decided_at       := null;
  new.decided_by       := null;
  new.rejection_reason := null;
  new.payment_id       := null;
  new.hold_expires_at  := now() + make_interval(secs => v_hold_minutes * 60);

  return new;
end;
$$;

drop trigger if exists trg_set_additional_head_request_defaults on public.reservation_additional_head_requests;
create trigger trg_set_additional_head_request_defaults
before insert on public.reservation_additional_head_requests
for each row execute function public.set_additional_head_request_defaults();

-- ============================================================
-- 4. Payment submission -> pending_verification, and notifications.
--    Mirrors link_extension_payment_submission() exactly.
-- ============================================================
create or replace function public.link_additional_head_payment_submission()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_reservation_id uuid;
  v_user_id        uuid;
begin
  if new.payment_type is distinct from 'additional_head_fee' or new.additional_head_request_id is null then
    return new;
  end if;

  update public.reservation_additional_head_requests
  set status = 'pending_verification', payment_id = new.payment_id
  where additional_head_request_id = new.additional_head_request_id
    and status = 'pending_payment'
  returning reservation_id into v_reservation_id;

  if v_reservation_id is not null then
    select user_id into v_user_id from public.reservations where reservation_id = v_reservation_id;
    if v_user_id is not null then
      insert into public.notifications (user_id, type, title, body, link)
      values (
        v_user_id,
        'reservation_status',
        'Additional Guests Payment Submitted',
        'We received your additional guests payment and it is now awaiting verification.',
        '/reservation-details.html?reservation_id=' || v_reservation_id
      );
    end if;

    insert into public.notifications (user_id, type, title, body, link)
    select p.user_id, 'admin_payment_submitted', 'Additional Guests Payment Uploaded',
           'A customer has submitted an additional guests payment that needs your review.',
           '/admin/payments.html'
    from public.profiles p
    where p.role = 'manager';
  end if;

  return new;
end;
$$;

drop trigger if exists trg_link_additional_head_payment_submission on public.payment;
create trigger trg_link_additional_head_payment_submission
after insert on public.payment
for each row execute function public.link_additional_head_payment_submission();

-- ============================================================
-- 5. Manager approval/rejection of the additional_head_fee payment —
--    mirrors finalize_extension_on_fee_approval() exactly: fired by the
--    SAME generic payment-review action js/admin_payments.js's
--    handlePaymentReview() already performs for every other payment type,
--    so admin needs no separate approve/reject UI.
--
--    Approval re-runs the package-cap/venue-capacity check as a final
--    safety net (package config or, in principle, the reservation's own
--    guest count could have moved since the request was made) — if it no
--    longer fits, the exception aborts the WHOLE payment-approval
--    transaction (payment_status never actually becomes 'approved'), so
--    the Manager sees a clear error instead of silently overbooking a
--    venue. On success it both finalizes reservation_additional_head_
--    requests AND increments the reservation's guest_count in place —
--    enforce_reservation_capacity()'s self-heal (section 7 below) is what
--    actually lands the authoritative additional_heads/guest_count
--    numbers; this UPDATE only needs to change a column its guard already
--    watches, to make that self-heal fire.
-- ============================================================
create or replace function public.finalize_additional_head_on_fee_approval()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_request        public.reservation_additional_head_requests%rowtype;
  v_reservation     public.reservations%rowtype;
  v_package         public.package%rowtype;
  v_new_total       integer;
  v_venue_capacity  integer;
begin
  if new.payment_type is distinct from 'additional_head_fee' or new.additional_head_request_id is null then
    return new;
  end if;
  if old.payment_status is not distinct from new.payment_status then
    return new;
  end if;
  if lower(coalesce(new.payment_status, '')) not in ('approved', 'rejected') then
    return new;
  end if;

  select * into v_request
  from public.reservation_additional_head_requests
  where additional_head_request_id = new.additional_head_request_id
    and status = 'pending_verification';

  if v_request.additional_head_request_id is null then
    return new;
  end if;

  select * into v_reservation from public.reservations where reservation_id = v_request.reservation_id;

  if lower(new.payment_status) = 'rejected' then
    update public.reservation_additional_head_requests
    set status = 'rejected',
        decided_at = now(),
        decided_by = auth.uid(),
        rejection_reason = new.rejection_reason
    where additional_head_request_id = v_request.additional_head_request_id;

    if v_reservation.user_id is not null then
      insert into public.notifications (user_id, type, title, body, link)
      values (
        v_reservation.user_id,
        'reservation_status',
        'Additional Guests Request Rejected',
        coalesce('Your additional guests request was rejected: ' || new.rejection_reason, 'Your additional guests request was rejected.'),
        '/reservation-details.html?reservation_id=' || v_reservation.reservation_id
      );
    end if;

    return new;
  end if;

  -- Approval: re-check package/venue capacity for a conflict that may
  -- have appeared since the request was made.
  select * into v_package from public.package p where p.package_id = v_reservation.package_id;
  v_new_total := coalesce(v_reservation.additional_heads, 0) + v_request.requested_heads;

  if v_package.max_additional_heads is not null and v_new_total > v_package.max_additional_heads then
    raise exception using
      errcode = 'P0001',
      message = 'This request can no longer be approved — it would exceed this package''s additional guest limit. Reject this request instead so the customer can be notified.';
  end if;

  if v_reservation.location_type = 'onsite' then
    if v_reservation.venue_id is null then
      raise exception using
        errcode = 'P0001',
        message = 'This request can no longer be approved — no venue is on file to verify capacity against. Reject this request instead so the customer can be notified.';
    end if;

    select capacity into v_venue_capacity from public.venue where venue_id = v_reservation.venue_id;

    if v_venue_capacity is not null and coalesce(v_package.max_guests, 0) + v_new_total > v_venue_capacity then
      raise exception using
        errcode = 'P0001',
        message = 'This request can no longer be approved — the total guest count would exceed the venue''s capacity. Reject this request instead so the customer can be notified.';
    end if;
  end if;

  update public.reservation_additional_head_requests
  set status = 'approved', decided_at = now(), decided_by = auth.uid()
  where additional_head_request_id = v_request.additional_head_request_id;

  update public.reservations
  set guest_count = guest_count + v_request.requested_heads
  where reservation_id = v_reservation.reservation_id;

  if v_reservation.user_id is not null then
    insert into public.notifications (user_id, type, title, body, link)
    values (
      v_reservation.user_id,
      'reservation_status',
      'Additional Guests Approved',
      'Your request to add ' || v_request.requested_heads || ' guest' || (case when v_request.requested_heads = 1 then '' else 's' end)
        || ' was approved. Your reservation now includes ' || v_new_total || ' additional guest' || (case when v_new_total = 1 then '' else 's' end)
        || ' beyond the package''s base guest count.',
      '/reservation-details.html?reservation_id=' || v_reservation.reservation_id
    );
  end if;

  return new;
end;
$$;

drop trigger if exists trg_finalize_additional_head_on_fee_approval on public.payment;
create trigger trg_finalize_additional_head_on_fee_approval
after update on public.payment
for each row execute function public.finalize_additional_head_on_fee_approval();

-- ============================================================
-- 6. Expiry job — unpaid holds only, same reasoning and 5-minute cadence
--    as expire_reservation_extensions() (a request in pending_verification
--    never expires out from under a Manager mid-review).
-- ============================================================
create or replace function public.expire_additional_head_requests()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  req record;
begin
  for req in
    select rah.additional_head_request_id, rah.reservation_id, r.user_id
    from public.reservation_additional_head_requests rah
    join public.reservations r on r.reservation_id = rah.reservation_id
    where rah.status = 'pending_payment'
      and rah.hold_expires_at is not null
      and rah.hold_expires_at < now()
  loop
    update public.reservation_additional_head_requests
    set status = 'expired', decided_at = now()
    where additional_head_request_id = req.additional_head_request_id;

    if req.user_id is not null then
      insert into public.notifications (user_id, type, title, body, link)
      values (
        req.user_id,
        'reservation_status',
        'Additional Guests Request Expired',
        'Your additional guests request expired before payment was submitted. You can request additional guests again any time if space is still available.',
        '/reservation-details.html?reservation_id=' || req.reservation_id
      );
    end if;
  end loop;
end;
$$;

grant execute on function public.expire_additional_head_requests() to service_role;

select cron.unschedule(jobid) from cron.job where jobname = 'expire-additional-head-requests';
select cron.schedule(
  'expire-additional-head-requests',
  '*/5 * * * *',
  $$select public.expire_additional_head_requests();$$
);

-- ============================================================
-- 7. enforce_reservation_capacity() — reproduced verbatim from its current
--    source (20261018_additional_per_head.sql) with two changes, both
--    additive: (a) additional_heads is now self-healed from
--    base_additional_heads + every APPROVED post-booking request, computed
--    once near the top so every downstream read (guest_count recompute,
--    cap/venue validation) already sees the true cumulative total; (b)
--    additional_head_price/additional_head_charge are only ever
--    (re)snapshotted on a true INSERT or a genuine change to the INITIAL
--    booking-time count — never on an update that only moved the
--    cumulative total via an approved post-booking request — so a later
--    admin price change, or this same block re-running for an unrelated
--    reason, can never silently reprice what the initial booking already
--    charged for. Everything else below is unchanged.
-- ============================================================
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

      if new.total_price < (coalesce(v_package_price, 0) - coalesce(new.discount_amount, 0) + coalesce(v_addon_price, 0)) then
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
  if v_scopes is not null and array_length(v_scopes, 1) = 1 then
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

      -- Onsite: total guests must fit the resolved venue. A combo package
      -- (never gets a venue_id) or one somehow still unresolved fails
      -- closed here rather than booking an unchecked headcount.
      if new.location_type = 'onsite' then
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
      coalesce(v_package_price, 0) - coalesce(new.discount_amount, 0)
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

    select count(*)
    into v_daily_count
    from public.reservations r
    where r.event_date = new.event_date
      and lower(coalesce(r.status, '')) in ('approved', 'confirmed', 'rescheduled')
      and r.venue_id = v_venue_id
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

-- ============================================================
-- 8. reservation_payment_summary — reproduced verbatim from its current
--    source (20260920_package_extension_hours.sql) with 'additional_head_
--    fee' added to the excluded payment_type list, same reasoning as
--    extension_fee: an approved fee-type payment must never inflate the
--    reservation's own paid-in-full status.
-- ============================================================
create or replace view public.reservation_payment_summary as
select
  r.reservation_id,
  r.total_price as reservation_total,
  coalesce(p.total_paid, 0) as total_paid,
  greatest(r.total_price - coalesce(p.total_paid, 0), 0) as outstanding_balance,
  p.latest_payment_date,
  case
    when coalesce(p.total_paid, 0) = 0 then 'unpaid'
    when coalesce(p.total_paid, 0) < r.total_price then 'partially_paid'
    when coalesce(p.total_paid, 0) = r.total_price then 'paid_in_full'
    else 'overpaid'
  end as computed_status
from public.reservations r
left join lateral (
  select
    sum(pay.amount) as total_paid,
    max(coalesce(pay.actual_payment_date, pay.payment_date, pay.cash_payment_date, pay.submitted_at::date)) as latest_payment_date
  from public.payment pay
  where pay.reservation_id = r.reservation_id
    and lower(pay.payment_status) = 'approved'
    and pay.payment_type not in ('cancellation_fee', 'reschedule_fee', 'extension_fee', 'additional_head_fee')
) p on true;

grant select on public.reservation_payment_summary to authenticated;

alter view public.reservation_payment_summary set (security_invoker = true);

-- ============================================================
-- 9. Critical fix — the customer INSERT policy on public.payment
--    (20260920_package_extension_hours.sql, "customer insert own base
--    payment") whitelists payment_type explicitly and did not, and could
--    not have, included 'additional_head_fee' (this feature didn't exist
--    yet). Without this, RLS silently rejects every customer's additional-
--    head-fee payment submission. Reproduced verbatim with only
--    'additional_head_fee' added, same convention as every other full-body
--    reproduction in this file.
-- ============================================================
drop policy if exists "customer insert own base payment" on public.payment;
create policy "customer insert own base payment"
  on public.payment for insert
  with check (
    payment_type in ('reservation_fee', 'down_payment', 'full_payment', 'partial_payment', 'reschedule_fee', 'extension_fee', 'additional_head_fee')
    and payment_status = 'pending_review'
    and exists (
      select 1 from public.reservations r
      where r.reservation_id = payment.reservation_id
        and r.user_id = auth.uid()
    )
  );

-- ============================================================
-- 10. notify_customer_on_payment_status() — reproduced verbatim from its
--     current source (20260921_fix_extension_fee_duplicate_notification.
--     sql) with the same skip added for 'additional_head_fee' as already
--     exists for 'extension_fee' — finalize_additional_head_on_fee_
--     approval() above is the sole source of notifications for this
--     payment type, for the identical reason documented there for
--     extension_fee (a generic "payment received" notification would show
--     the reservation's cumulative total_paid framed as "your payment",
--     which is wrong for a fee-type payment).
-- ============================================================
create or replace function public.notify_customer_on_payment_status()
returns trigger language plpgsql security definer as $$
declare
  v_user_id uuid;
  v_merge_data jsonb;
begin
  if NEW.payment_status is not distinct from OLD.payment_status then return NEW; end if;
  if NEW.payment_type = 'extension_fee' then return NEW; end if;
  if NEW.payment_type = 'additional_head_fee' then return NEW; end if;

  select r.user_id into v_user_id from reservations r where r.reservation_id = NEW.reservation_id;
  if v_user_id is null then return NEW; end if;

  case NEW.payment_status
    when 'approved' then
      v_merge_data := public.build_notification_merge_data(NEW.reservation_id);
      perform public.dispatch_notification(v_user_id, 'payment_received', 'payment_status', '/notifications.html', v_merge_data);
    when 'rejected' then
      v_merge_data := public.build_notification_merge_data(NEW.reservation_id)
        || jsonb_build_object('rejection_reason', coalesce(NEW.rejection_reason, 'Not specified'));
      perform public.dispatch_notification(v_user_id, 'payment_rejected', 'payment_status', '/notifications.html', v_merge_data);
    else return NEW;
  end case;

  return NEW;
end;
$$;

-- ============================================================
-- 11. validate_payment_submission() — reproduced verbatim from its current
--     source (20260921_payment_target_validation.sql) with an
--     'additional_head_fee' branch added, mirroring the 'extension_fee'
--     branch exactly (ownership implied by resolving the target against
--     new.reservation_id, status must be pending_payment and unexpired,
--     amount must equal the request's own snapshotted total_price), and
--     the duplicate-pending guard's scoping extended the same way
--     extension_id already is.
-- ============================================================
create or replace function public.validate_payment_submission()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_reservation    public.reservations%rowtype;
  v_approved_total numeric;
  v_remaining      numeric;
  v_deposit_pct    numeric := 30;
  v_min_amount     numeric;
  v_rules          jsonb;
  v_payment_rules  jsonb;
  v_has_pending    boolean;
  v_extension      public.reservation_extensions%rowtype;
  v_additional_head public.reservation_additional_head_requests%rowtype;
  v_reschedule     public.reschedule_requests%rowtype;
  v_expected_fee   numeric;
begin
  if new.payment_source = 'in_cafe' then
    return new;
  end if;

  -- Staff-recorded/administered inserts skip the customer self-service
  -- eligibility checks below entirely — those exist to stop a CUSTOMER
  -- from submitting against a settled/pending/invalid/expired target, not
  -- to second-guess staff who already have their own RLS-gated,
  -- role-restricted policies on this table.
  if public.get_my_role() in ('manager', 'admin') then
    return new;
  end if;

  -- Ownership, server-side. A tampered reservation_id (someone else's
  -- reservation) fails right here, before any target-specific lookup runs
  -- — every target below is resolved by joining back to
  -- new.reservation_id, so ownership of the target follows from ownership
  -- of the reservation without a second auth.uid() check per type.
  select * into v_reservation
  from public.reservations r
  where r.reservation_id = new.reservation_id
    and r.user_id = auth.uid();

  if v_reservation.reservation_id is null then
    raise exception 'Reservation not found for this payment.';
  end if;

  select setting_value::jsonb into v_payment_rules
  from public.system_settings
  where setting_key = 'payment_rules';

  if new.payment_type = 'extension_fee' then
    -- ── Target: reservation_extensions ────────────────────────────────
    if new.extension_id is null then
      raise exception 'An extension request must be specified for this payment.';
    end if;

    select * into v_extension
    from public.reservation_extensions e
    where e.extension_id = new.extension_id
      and e.reservation_id = new.reservation_id;

    if v_extension.extension_id is null then
      raise exception 'Extension request not found for this reservation.';
    end if;

    if v_extension.status = 'pending_verification' then
      raise exception 'A payment for this extension has already been submitted and is awaiting review.';
    elsif v_extension.status = 'approved' then
      raise exception 'This extension has already been paid and approved — no further payment is needed.';
    elsif v_extension.status = 'rejected' then
      raise exception 'This extension request was rejected. Please submit a new extension request.';
    elsif v_extension.status = 'expired' then
      raise exception 'This extension request has expired. Please submit a new extension request.';
    elsif v_extension.status <> 'pending_payment' then
      raise exception 'This extension request is no longer available for payment.';
    end if;

    if v_extension.hold_expires_at is not null and v_extension.hold_expires_at < now() then
      raise exception 'This extension request has expired. Please submit a new extension request.';
    end if;

    -- A reservation that's since moved into cancellation has no legitimate
    -- reason to pay for MORE time on it — cancellation doesn't currently
    -- auto-void an open extension the way it auto-voids an open reschedule
    -- (20260907_cancellation_supersedes_reschedule.sql), so this is the
    -- one place that has to be checked explicitly instead of inherited
    -- from the target's own status.
    if lower(coalesce(v_reservation.status, '')) in ('cancelled', 'declined', 'cancellation_requested', 'cancellation_approved') then
      raise exception 'This reservation is cancelled, or a cancellation is pending — the extension can no longer be paid for.';
    end if;

    if round(coalesce(new.amount, -1), 2) is distinct from round(v_extension.total_price, 2) then
      raise exception 'Payment amount must equal the extension fee of %.', v_extension.total_price;
    end if;

  elsif new.payment_type = 'additional_head_fee' then
    -- ── Target: reservation_additional_head_requests ──────────────────
    if new.additional_head_request_id is null then
      raise exception 'An additional guests request must be specified for this payment.';
    end if;

    select * into v_additional_head
    from public.reservation_additional_head_requests h
    where h.additional_head_request_id = new.additional_head_request_id
      and h.reservation_id = new.reservation_id;

    if v_additional_head.additional_head_request_id is null then
      raise exception 'Additional guests request not found for this reservation.';
    end if;

    if v_additional_head.status = 'pending_verification' then
      raise exception 'A payment for this request has already been submitted and is awaiting review.';
    elsif v_additional_head.status = 'approved' then
      raise exception 'This request has already been paid and approved — no further payment is needed.';
    elsif v_additional_head.status = 'rejected' then
      raise exception 'This additional guests request was rejected. Please submit a new request.';
    elsif v_additional_head.status = 'expired' then
      raise exception 'This additional guests request has expired. Please submit a new request.';
    elsif v_additional_head.status <> 'pending_payment' then
      raise exception 'This additional guests request is no longer available for payment.';
    end if;

    if v_additional_head.hold_expires_at is not null and v_additional_head.hold_expires_at < now() then
      raise exception 'This additional guests request has expired. Please submit a new request.';
    end if;

    if lower(coalesce(v_reservation.status, '')) in ('cancelled', 'declined', 'cancellation_requested', 'cancellation_approved') then
      raise exception 'This reservation is cancelled, or a cancellation is pending — additional guests can no longer be paid for.';
    end if;

    if round(coalesce(new.amount, -1), 2) is distinct from round(v_additional_head.total_price, 2) then
      raise exception 'Payment amount must equal the additional guests fee of %.', v_additional_head.total_price;
    end if;

  elsif new.payment_type = 'reschedule_fee' then
    -- ── Target: reschedule_requests ───────────────────────────────────
    if new.reschedule_request_id is null then
      raise exception 'A reschedule request must be specified for this payment.';
    end if;

    select * into v_reschedule
    from public.reschedule_requests rr
    where rr.reschedule_request_id = new.reschedule_request_id
      and rr.reservation_id = new.reservation_id;

    if v_reschedule.reschedule_request_id is null then
      raise exception 'Reschedule request not found for this reservation.';
    end if;

    if v_reschedule.status = 'completed' then
      raise exception 'This reschedule has already been paid and completed — no further payment is needed.';
    elsif v_reschedule.status = 'rejected' then
      raise exception 'This reschedule request was rejected.';
    elsif v_reschedule.status in ('voided', 'withdrawn', 'expired') then
      raise exception 'This reschedule request is no longer active. Please check your reservation for its current status.';
    elsif v_reschedule.status <> 'approved_pending_payment' then
      raise exception 'This reschedule request is not currently awaiting payment.';
    end if;

    if v_reschedule.hold_expires_at is not null and v_reschedule.hold_expires_at < now() then
      raise exception 'This reschedule request has expired. Please check your reservation for its current status.';
    end if;

    v_expected_fee := coalesce((v_payment_rules->>'reschedule_fee')::numeric, 3000);
    if round(coalesce(new.amount, -1), 2) is distinct from round(v_expected_fee, 2) then
      raise exception 'Payment amount must equal the reschedule fee of %.', v_expected_fee;
    end if;

  elsif new.payment_type = 'cancellation_fee' then
    -- ── Target: the reservation's own cancellation state ──────────────
    -- No separate id column (unlike extension/reschedule/additional-head)
    -- — a reservation can only have one live cancellation attempt at a
    -- time, so reservation_id + payment_type is already an unambiguous
    -- target, matching reservation_cancellations' own one-row-per-
    -- reservation (on conflict (reservation_id)) shape.
    if lower(coalesce(v_reservation.status, '')) not in ('cancellation_requested', 'cancellation_approved', 'cancelled') then
      raise exception 'This reservation has no cancellation in progress.';
    end if;

    if v_reservation.status = 'cancellation_requested'
       and v_reservation.cancellation_hold_expires_at is not null
       and v_reservation.cancellation_hold_expires_at < now() then
      raise exception 'This cancellation window has expired. Please check your reservation for its current status.';
    end if;

    v_expected_fee := coalesce(
      (v_payment_rules->>(case when lower(coalesce(v_reservation.location_type, '')) = 'offsite'
        then 'cancellation_fee_offsite' else 'cancellation_fee_onsite' end))::numeric,
      case when lower(coalesce(v_reservation.location_type, '')) = 'offsite' then 2000 else 500 end
    );
    if round(coalesce(new.amount, -1), 2) is distinct from round(v_expected_fee, 2) then
      raise exception 'Payment amount must equal the cancellation fee of %.', v_expected_fee;
    end if;

  else
    -- ── Target: the reservation's own base balance ────────────────────
    -- reservation_fee / down_payment / full_payment / partial_payment.
    if lower(coalesce(v_reservation.status, '')) in ('cancelled', 'declined', 'cancellation_requested', 'cancellation_approved') then
      raise exception 'This reservation is cancelled, or a cancellation is pending — no further payment can be submitted.';
    end if;
  end if;

  -- ── Duplicate-pending guard ──────────────────────────────────────────
  -- Scoped to the specific target: reschedule_request_id for reschedule_fee,
  -- extension_id for extension_fee, additional_head_request_id for
  -- additional_head_fee (a reservation can cycle through more than one of
  -- any of these over its life, each with its own fee — a pending payment
  -- on a PAST one must never block a fresh one on a NEW request), and to
  -- the reservation for every other type (cancellation_fee and the four
  -- base types only ever have one live target at a time).
  select exists (
    select 1 from public.payment p
    where p.reservation_id = new.reservation_id
      and p.payment_type = new.payment_type
      and lower(coalesce(p.payment_status, '')) = 'pending_review'
      and (
        (new.payment_type = 'reschedule_fee' and p.reschedule_request_id is not distinct from new.reschedule_request_id)
        or (new.payment_type = 'extension_fee' and p.extension_id is not distinct from new.extension_id)
        or (new.payment_type = 'additional_head_fee' and p.additional_head_request_id is not distinct from new.additional_head_request_id)
        or (new.payment_type not in ('reschedule_fee', 'extension_fee', 'additional_head_fee'))
      )
  ) into v_has_pending;

  if v_has_pending then
    raise exception 'A payment of this type has already been submitted and is awaiting review.';
  end if;

  -- ── Remaining-balance guard — base payment types only ───────────────
  -- reschedule_fee/cancellation_fee/extension_fee/additional_head_fee are
  -- flat fees unrelated to the base package balance, already amount-checked
  -- against their own target above.
  if new.payment_type in ('reservation_fee', 'down_payment', 'full_payment', 'partial_payment') then
    select coalesce(sum(p.amount), 0) into v_approved_total
    from public.payment p
    where p.reservation_id = new.reservation_id
      and p.payment_type in ('reservation_fee', 'down_payment', 'full_payment', 'partial_payment')
      and lower(p.payment_status) = 'approved';

    if greatest(coalesce(v_reservation.total_price, 0) - v_approved_total, 0) <= 0 then
      raise exception 'This reservation is already paid in full — no further payment is needed.';
    end if;
  end if;

  -- Reference-number format (unchanged from 20260901_bank_transfer_
  -- generic_reference.sql).
  if new.reference_number is not null and new.payment_method in ('gcash', 'maya', 'bpi', 'bank') then
    if new.payment_method = 'gcash' and new.reference_number !~ '^[0-9]{13}$' then
      raise exception 'GCash reference number must be exactly 13 digits.';
    elsif new.payment_method = 'maya' and new.reference_number !~ '^[0-9]{12,13}$' then
      raise exception 'Maya reference number must be 12 to 13 digits.';
    elsif new.payment_method in ('bpi', 'bank') and new.reference_number !~ '^[A-Za-z0-9-]{6,30}$' then
      raise exception 'Bank transfer reference number must be 6 to 30 letters, numbers, or hyphens.';
    end if;
  end if;

  -- partial_payment amount bounds (unchanged logic).
  if new.payment_type = 'partial_payment' then
    select coalesce(sum(p.amount), 0) into v_approved_total
    from public.payment p
    where p.reservation_id = new.reservation_id
      and p.reschedule_request_id is null
      and lower(p.payment_status) = 'approved';

    v_remaining := greatest(coalesce(v_reservation.total_price, 0) - v_approved_total, 0);

    select setting_value::jsonb into v_rules
    from public.system_settings
    where setting_key = 'reservation_rules';

    if v_rules is not null and v_rules ? 'deposit_pct' then
      v_deposit_pct := (v_rules->>'deposit_pct')::numeric;
    end if;

    v_min_amount := round(least(coalesce(v_reservation.total_price, 0) * v_deposit_pct / 100, v_remaining), 2);

    if new.amount is null or new.amount <= 0 then
      raise exception 'Custom payment amount must be greater than zero.';
    end if;
    if new.amount < v_min_amount then
      raise exception 'Custom payment amount must be at least %.', v_min_amount;
    end if;
    if new.amount > v_remaining then
      raise exception 'Custom payment amount cannot exceed the remaining balance of %.', v_remaining;
    end if;
  end if;

  return new;
end;
$$;

-- trg_validate_payment_submission (before insert on public.payment,
-- 20260716_payment_overhaul.sql) already points at this function by name
-- — no trigger changes needed, create or replace above is sufficient.
