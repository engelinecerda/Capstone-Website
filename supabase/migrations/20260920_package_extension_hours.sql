-- Package Extension Hours — customers can request extra time added onto an
-- already-booked reservation, priced per hour via the existing (already
-- live, already admin-editable — see js/super_admin_packages.js's
-- pkgExtensionPrice field) package.extension_price column. Full spec: an
-- extension request holds its requested extra time on the calendar the
-- moment it's submitted (before payment, before approval), expires
-- automatically if unpaid, and only becomes real (extends the reservation's
-- actual blocked time system-wide) once a Manager approves its submitted
-- payment — mirroring this codebase's existing reschedule-fee /
-- cancellation-fee "pay first, manager verifies" pattern as closely as
-- possible rather than inventing a new one.
--
-- Model B: Manager approves/rejects extension requests (via approving/
-- rejecting the extension_fee payment, exactly like reschedule_fee) and
-- verifies extension payments. Admin configures package.extension_price
-- (already true before this migration — no new admin write surface is
-- added here) but gets no approve/reject action — same
-- get_my_role() = 'manager' gate every other operational mutation in this
-- app already uses.
-- ═══════════════════════════════════════════════════════════════════════════

-- ============================================================
-- 1. reservation_extensions
-- ============================================================
create table if not exists public.reservation_extensions (
  extension_id      uuid primary key default gen_random_uuid(),
  reservation_id    uuid not null references public.reservations(reservation_id) on delete cascade,
  requested_hours   numeric(4,1) not null check (requested_hours > 0),
  price_per_hour    numeric(12,2) not null,
  total_price       numeric(12,2) not null,
  -- pending_payment       — just requested, holds the slot, expires if unpaid
  -- pending_verification  — payment submitted, awaiting Manager review
  -- approved              — Manager approved the payment; reservation's
  --                         effective end time has been extended
  -- rejected              — Manager rejected the payment; hold released
  -- expired               — unpaid past hold_expires_at; hold released
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

create index if not exists reservation_extensions_reservation_id_idx
  on public.reservation_extensions (reservation_id);

-- Used by expire_reservation_extensions()'s WHERE clause below.
create index if not exists reservation_extensions_pending_hold_idx
  on public.reservation_extensions (status, hold_expires_at)
  where status = 'pending_payment';

-- payment.extension_id first (payment already exists), then the reverse FK
-- on reservation_extensions.payment_id — same two-step order needed because
-- the two tables reference each other.
alter table public.payment
  add column if not exists extension_id uuid references public.reservation_extensions(extension_id) on delete set null;

alter table public.reservation_extensions
  drop constraint if exists reservation_extensions_payment_id_fkey;
alter table public.reservation_extensions
  add constraint reservation_extensions_payment_id_fkey
  foreign key (payment_id) references public.payment(payment_id) on delete set null;

-- 'extension_fee' joins the six payment_type values already enforced here
-- (20260728_fix_payment_type_check.sql) as a seventh penalty/change-fee type,
-- same reasoning as reschedule_fee/cancellation_fee: not an admin-configurable
-- base payment_type row, but still a value this column must accept.
alter table public.payment drop constraint if exists payment_payment_type_check;
alter table public.payment add constraint payment_payment_type_check
  check (payment_type in (
    'reservation_fee',
    'down_payment',
    'full_payment',
    'partial_payment',
    'reschedule_fee',
    'cancellation_fee',
    'extension_fee'
  ));

-- ── RLS ──────────────────────────────────────────────────────────────────
-- No UPDATE/DELETE policy for any role: every status transition (submit
-- payment -> pending_verification, Manager approves/rejects the payment ->
-- approved/rejected, unpaid timeout -> expired) happens inside a SECURITY
-- DEFINER trigger/cron function below, which bypasses RLS entirely. Manager
-- and Admin only ever need to SELECT this table (Manager to act on the
-- linked payment in the existing verification queue, Admin for read-only
-- oversight per Model B) — neither writes it directly from the client.
alter table public.reservation_extensions enable row level security;

drop policy if exists "customer_select_own_extensions" on public.reservation_extensions;
create policy "customer_select_own_extensions"
  on public.reservation_extensions for select
  using (
    exists (
      select 1 from public.reservations r
      where r.reservation_id = reservation_extensions.reservation_id
        and r.user_id = auth.uid()
    )
  );

drop policy if exists "staff_select_all_extensions" on public.reservation_extensions;
create policy "staff_select_all_extensions"
  on public.reservation_extensions for select
  using (get_my_role() in ('manager', 'admin', 'staff'));

-- Customer inserts their own request; every field the trigger below doesn't
-- explicitly own (status, price_per_hour, total_price, hold_expires_at,
-- requested_at) is still client-submittable at the RLS layer but gets
-- overwritten unconditionally by set_extension_request_defaults() — RLS only
-- needs to guard reservation ownership here, not field-by-field trust.
drop policy if exists "customer_insert_own_extension" on public.reservation_extensions;
create policy "customer_insert_own_extension"
  on public.reservation_extensions for insert
  with check (
    exists (
      select 1 from public.reservations r
      where r.reservation_id = reservation_extensions.reservation_id
        and r.user_id = auth.uid()
    )
  );

grant select, insert on public.reservation_extensions to authenticated;

-- ============================================================
-- 2. get_extension_availability() — the ONE place "how much can this
--    reservation still extend by" is computed, shared by the customer-
--    facing pre-flight RPC (get_max_extension_hours, called before showing
--    the request UI) and the request-time trigger's authoritative re-check
--    below (never trust a client-submitted requested_hours against a
--    client-computed max) and the Manager-approval-time re-check further
--    down — same "factor into one shared function instead of copy-pasting
--    it three times" principle count_held_reschedule_conflicts() already
--    established in this file's neighboring migrations.
--
--    Gap = time between this reservation's CURRENT effective end time
--    (event_end_time, which already includes every previously-approved
--    extension — see enforce_reservation_capacity() below) and whichever
--    comes first: the café's closing time that weekday, another blocking
--    reservation's start time in the same scope/date, or another
--    customer's still-held reschedule request targeting that scope/date —
--    minus the existing scheduling buffer, then floored to a whole hour
--    (extensions are booked in whole-hour increments, same granularity
--    package.duration_hours itself already uses everywhere in this app).
-- ============================================================
create or replace function public.get_extension_availability(p_reservation_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_reservation    public.reservations%rowtype;
  v_package_name   text;
  v_extension_price numeric;
  v_scope          text;
  v_current_end    time;
  v_weekday        integer;
  v_close          time;
  v_buffer_minutes integer := 30;
  v_next_start     time;
  v_next_label     text;
  v_gap_minutes    numeric;
  v_gap_hours      numeric;
begin
  select * into v_reservation from public.reservations where reservation_id = p_reservation_id;
  if v_reservation.reservation_id is null then
    return jsonb_build_object('max_hours', 0, 'price_per_hour', null, 'extendable', false, 'next_booking_label', null);
  end if;

  select p.package_name, p.extension_price
  into v_package_name, v_extension_price
  from public.package p
  where p.package_id = v_reservation.package_id;

  v_scope := coalesce(v_reservation.booking_scope, public.normalize_booking_scope(v_reservation.location_type, v_package_name));
  v_current_end := coalesce(v_reservation.event_end_time, public.parse_event_time_text(v_reservation.event_time));

  if v_extension_price is null or v_current_end is null or v_scope is null
     or not public.is_capacity_blocking_reservation_status(v_reservation.status) then
    return jsonb_build_object('max_hours', 0, 'price_per_hour', v_extension_price, 'extendable', false, 'next_booking_label', null);
  end if;

  select buffer_minutes into v_buffer_minutes from public.scheduling_settings where id = true;
  v_buffer_minutes := coalesce(v_buffer_minutes, 30);

  v_weekday := extract(dow from v_reservation.event_date);
  select close_time into v_close from public.operating_hours where weekday = v_weekday;
  v_close := coalesce(v_close, '22:00'::time);

  select candidates.next_start, candidates.label
  into v_next_start, v_next_label
  from (
    select public.parse_event_time_text(r.event_time) as next_start,
           to_char(v_reservation.event_date + public.parse_event_time_text(r.event_time), 'FMHH12:MI AM') as label
    from public.reservations r
    left join public.package rp on rp.package_id = r.package_id
    where r.event_date = v_reservation.event_date
      and r.reservation_id <> v_reservation.reservation_id
      and public.is_capacity_blocking_reservation_status(r.status)
      and coalesce(r.booking_scope, public.normalize_booking_scope(r.location_type, rp.package_name)) = v_scope
      and public.parse_event_time_text(r.event_time) > v_current_end

    union all

    select public.parse_event_time_text(rr.requested_time) as next_start,
           to_char(v_reservation.event_date + public.parse_event_time_text(rr.requested_time), 'FMHH12:MI AM') as label
    from public.reschedule_requests rr
    join public.reservations rres on rres.reservation_id = rr.reservation_id
    left join public.package rrp on rrp.package_id = rres.package_id
    where rr.requested_date = v_reservation.event_date
      and rr.status = 'approved_pending_payment'
      and rr.hold_expires_at > now()
      and coalesce(rres.booking_scope, public.normalize_booking_scope(rres.location_type, rrp.package_name)) = v_scope
      and public.parse_event_time_text(rr.requested_time) > v_current_end
  ) candidates
  order by candidates.next_start
  limit 1;

  if v_next_start is not null then
    v_next_start := (v_next_start - make_interval(mins => v_buffer_minutes))::time;
    if v_next_start < v_close then
      v_close := v_next_start;
    end if;
  end if;

  v_gap_minutes := extract(epoch from (v_close - v_current_end)) / 60;
  v_gap_hours := greatest(floor(coalesce(v_gap_minutes, 0) / 60), 0);

  return jsonb_build_object(
    'max_hours', v_gap_hours,
    'price_per_hour', v_extension_price,
    'extendable', v_gap_hours > 0,
    'next_booking_label', case when v_next_label is not null and v_gap_minutes > 0 and v_next_start is not null then v_next_label else null end
  );
end;
$$;

-- Public entry point — verifies the caller owns the reservation (or is
-- Manager/Admin/staff, so the same function can back the admin-side
-- approval re-check's own sanity display if ever needed) before exposing
-- another customer's scheduling detail via reservation_id guessing.
create or replace function public.get_max_extension_hours(p_reservation_id uuid)
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

  return public.get_extension_availability(p_reservation_id);
end;
$$;

grant execute on function public.get_max_extension_hours(uuid) to authenticated;

-- ============================================================
-- 3. count_held_extension_conflicts() — the extension-hold analog of
--    count_held_reschedule_conflicts() (20260909_reschedule_hold_and_
--    cancellation_debt.sql §6). Deliberately time-range-only: unlike a
--    reschedule hold (a brand-new slot claim that must also count against
--    the scope's DAILY capacity cap), an extension hold sits on top of a
--    reservation that already consumes its own daily-capacity slot — so
--    this is wired into the TIME-OVERLAP checks below only, never into a
--    daily-count/capacity-limit check, or an approved-but-still-open
--    extension would incorrectly shrink that scope's remaining daily cap.
-- ============================================================
create or replace function public.count_held_extension_conflicts(
  p_date                   date,
  p_scope                  text,
  p_slot_start             time,
  p_slot_end               time,
  p_buffer_minutes         integer default 0,
  p_exclude_reservation_id uuid default null
)
returns integer
language sql
stable
security definer
set search_path = public
as $$
  select count(*)::integer
  from public.reservation_extensions re
  join public.reservations res on res.reservation_id = re.reservation_id
  left join public.package resp on resp.package_id = res.package_id
  where res.event_date = p_date
    and (
      re.status = 'pending_verification'
      or (re.status = 'pending_payment' and re.hold_expires_at > now())
    )
    and (p_exclude_reservation_id is null or res.reservation_id <> p_exclude_reservation_id)
    and coalesce(res.booking_scope, public.normalize_booking_scope(res.location_type, resp.package_name)) = p_scope
    and p_slot_start is not null
    and public.booking_times_overlap(
      (p_slot_start - make_interval(mins => p_buffer_minutes))::time,
      (p_slot_end + make_interval(mins => p_buffer_minutes))::time,
      coalesce(res.event_end_time, public.parse_event_time_text(res.event_time)),
      (
        coalesce(res.event_end_time, public.parse_event_time_text(res.event_time))
        + make_interval(secs => re.requested_hours * 3600)
      )::time
    );
$$;

-- ============================================================
-- 4. Request-time trigger — server-side authority for everything the
--    customer-facing UI also checks client-side (item 2/3 of the spec):
--    reservation must be in an extension-eligible state, no other request
--    already open, requested_hours never exceeds the real gap (re-derived
--    here, never trusted from the client), price snapshotted from
--    package.extension_price ONCE (never re-read again — a later admin
--    price change must not retroactively alter this request), and the
--    hold's expiry is stamped from the server clock.
-- ============================================================
create or replace function public.set_extension_request_defaults()
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
    raise exception using errcode = 'P0001', message = 'This reservation is not yet eligible for an extension request.';
  end if;

  -- Only one open extension request at a time per reservation — later
  -- requests (after this one resolves, one way or another) are fine and
  -- expected; a second concurrent open one is not. Mirrors the identical
  -- guard set_reschedule_hold_expiry() applies to reschedule_requests.
  if exists (
    select 1 from public.reservation_extensions existing
    where existing.reservation_id = new.reservation_id
      and (
        existing.status = 'pending_verification'
        or (existing.status = 'pending_payment' and existing.hold_expires_at > now())
      )
  ) then
    raise exception using
      errcode = 'P0001',
      message = 'You already have an open extension request for this reservation — wait for it to be resolved before requesting another.';
  end if;

  if new.requested_hours <> floor(new.requested_hours) then
    raise exception using errcode = 'P0001', message = 'Extensions must be requested in whole-hour increments.';
  end if;

  v_availability := public.get_extension_availability(new.reservation_id);

  if not (v_availability->>'extendable')::boolean then
    raise exception using errcode = 'P0001', message = 'This reservation cannot be extended right now.';
  end if;

  if new.requested_hours > (v_availability->>'max_hours')::numeric then
    raise exception using
      errcode = 'P0001',
      message = format('You can extend by up to %s hour(s) — %s.',
        (v_availability->>'max_hours')::numeric,
        case when v_availability->>'next_booking_label' is not null
          then 'the next slot is booked at ' || (v_availability->>'next_booking_label')
          else 'that is the remaining time before closing'
        end
      );
  end if;

  select ss.setting_value::jsonb into v_rules_json
  from public.system_settings ss
  where ss.setting_key = 'payment_rules';
  v_hold_minutes := coalesce((v_rules_json->>'extension_hold_minutes')::numeric, 45);

  new.price_per_hour  := (v_availability->>'price_per_hour')::numeric;
  new.total_price     := round(new.requested_hours * new.price_per_hour, 2);
  new.status          := 'pending_payment';
  new.requested_at    := now();
  new.decided_at      := null;
  new.decided_by      := null;
  new.rejection_reason := null;
  new.payment_id      := null;
  -- make_interval()'s hours parameter is integer-only (see the identical
  -- note on set_reschedule_hold_expiry() above) — seconds avoids truncating
  -- a fractional-minute config value.
  new.hold_expires_at := now() + make_interval(secs => v_hold_minutes * 60);

  return new;
end;
$$;

drop trigger if exists trg_set_extension_request_defaults on public.reservation_extensions;
create trigger trg_set_extension_request_defaults
before insert on public.reservation_extensions
for each row execute function public.set_extension_request_defaults();

-- ============================================================
-- 5. Payment submission -> pending_verification, and notifications.
--    Mirrors how a reschedule fee payment links back via
--    payment.reschedule_request_id, just for extensions.
-- ============================================================
create or replace function public.link_extension_payment_submission()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_reservation_id uuid;
  v_user_id        uuid;
begin
  if new.payment_type is distinct from 'extension_fee' or new.extension_id is null then
    return new;
  end if;

  update public.reservation_extensions
  set status = 'pending_verification', payment_id = new.payment_id
  where extension_id = new.extension_id
    and status = 'pending_payment'
  returning reservation_id into v_reservation_id;

  if v_reservation_id is not null then
    select user_id into v_user_id from public.reservations where reservation_id = v_reservation_id;
    if v_user_id is not null then
      insert into public.notifications (user_id, type, title, body, link)
      values (
        v_user_id,
        'reservation_status',
        'Extension Payment Submitted',
        'We received your extension payment and it is now awaiting verification.',
        '/reservation-details.html?reservation_id=' || v_reservation_id
      );
    end if;

    insert into public.notifications (user_id, type, title, body, link)
    select p.user_id, 'admin_payment_submitted', 'Extension Payment Uploaded',
           'A customer has submitted an extension payment that needs your review.',
           '/admin/payments.html'
    from public.profiles p
    where p.role = 'manager';
  end if;

  return new;
end;
$$;

drop trigger if exists trg_link_extension_payment_submission on public.payment;
create trigger trg_link_extension_payment_submission
after insert on public.payment
for each row execute function public.link_extension_payment_submission();

-- ============================================================
-- 6. Manager approval/rejection of the extension_fee payment — mirrors
--    finalize_cancellation_on_fee_approval() exactly: a SECURITY DEFINER
--    trigger fired by the SAME payment-review action js/admin_payments.js's
--    handlePaymentReview() already performs for every other payment type,
--    so this can't be bypassed or duplicated by a different UI path.
--
--    Approval re-runs the item-2 conflict check as a final safety check
--    (spec item 5) — if another booking has landed on this slot since the
--    request was made, the exception here aborts the ENTIRE payment update
--    transaction (payment_status never actually becomes 'approved'), so
--    the Manager sees a clear error instead of silently double-booking.
--    On success it both finalizes reservation_extensions AND extends the
--    reservation's event_end_time in place — see the note on
--    enforce_reservation_capacity() below for why that one column is the
--    system-wide "effective end time" every other surface already reads.
-- ============================================================
create or replace function public.finalize_extension_on_fee_approval()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_extension    public.reservation_extensions%rowtype;
  v_reservation  public.reservations%rowtype;
  v_package_name text;
  v_scope        text;
  v_new_end      time;
  v_conflict     boolean;
begin
  if new.payment_type is distinct from 'extension_fee' or new.extension_id is null then
    return new;
  end if;
  if old.payment_status is not distinct from new.payment_status then
    return new;
  end if;
  if lower(coalesce(new.payment_status, '')) not in ('approved', 'rejected') then
    return new;
  end if;

  select * into v_extension
  from public.reservation_extensions
  where extension_id = new.extension_id
    and status = 'pending_verification';

  if v_extension.extension_id is null then
    return new;
  end if;

  select * into v_reservation from public.reservations where reservation_id = v_extension.reservation_id;

  if lower(new.payment_status) = 'rejected' then
    update public.reservation_extensions
    set status = 'rejected',
        decided_at = now(),
        decided_by = auth.uid(),
        rejection_reason = new.rejection_reason
    where extension_id = v_extension.extension_id;

    if v_reservation.user_id is not null then
      insert into public.notifications (user_id, type, title, body, link)
      values (
        v_reservation.user_id,
        'reservation_status',
        'Extension Request Rejected',
        coalesce('Your extension request was rejected: ' || new.rejection_reason, 'Your extension request was rejected.'),
        '/reservation-details.html?reservation_id=' || v_reservation.reservation_id
      );
    end if;

    return new;
  end if;

  -- Approval: re-check for a conflict that may have appeared since the
  -- request was made (spec item 5's "final safety check").
  select p.package_name into v_package_name from public.package p where p.package_id = v_reservation.package_id;
  v_scope := coalesce(v_reservation.booking_scope, public.normalize_booking_scope(v_reservation.location_type, v_package_name));
  v_new_end := (coalesce(v_reservation.event_end_time, public.parse_event_time_text(v_reservation.event_time)) + make_interval(secs => v_extension.requested_hours * 3600))::time;

  select exists (
    select 1
    from public.reservations r
    left join public.package rp on rp.package_id = r.package_id
    where r.event_date = v_reservation.event_date
      and r.reservation_id <> v_reservation.reservation_id
      and public.is_capacity_blocking_reservation_status(r.status)
      and coalesce(r.booking_scope, public.normalize_booking_scope(r.location_type, rp.package_name)) = v_scope
      and public.booking_times_overlap(
        coalesce(v_reservation.event_end_time, public.parse_event_time_text(v_reservation.event_time)),
        v_new_end,
        public.parse_event_time_text(r.event_time),
        coalesce(r.event_end_time, (public.parse_event_time_text(r.event_time) + make_interval(hours => coalesce(rp.duration_hours, 3)))::time)
      )
  ) into v_conflict;

  if v_conflict then
    raise exception using
      errcode = 'P0001',
      message = 'This extension can no longer be approved — another booking now overlaps the requested time. Reject this request instead so the customer can be notified.';
  end if;

  update public.reservation_extensions
  set status = 'approved', decided_at = now(), decided_by = auth.uid()
  where extension_id = v_extension.extension_id;

  update public.reservations
  set event_end_time = v_new_end
  where reservation_id = v_reservation.reservation_id;

  if v_reservation.user_id is not null then
    insert into public.notifications (user_id, type, title, body, link)
    values (
      v_reservation.user_id,
      'reservation_status',
      'Extension Approved',
      'Your ' || v_extension.requested_hours || '-hour extension was approved. Your event now ends at ' || to_char(v_reservation.event_date + v_new_end, 'FMHH12:MI AM') || '.',
      '/reservation-details.html?reservation_id=' || v_reservation.reservation_id
    );
  end if;

  return new;
end;
$$;

drop trigger if exists trg_finalize_extension_on_fee_approval on public.payment;
create trigger trg_finalize_extension_on_fee_approval
after update on public.payment
for each row execute function public.finalize_extension_on_fee_approval();

-- ============================================================
-- 7. Expiry job — unpaid holds only (status = 'pending_payment'); a request
--    already in 'pending_verification' (payment submitted, awaiting the
--    Manager) never expires out from under a manager mid-review, since it
--    was never given a deadline for that phase in the first place (see
--    trg_set_extension_request_defaults — hold_expires_at only ever governs
--    the unpaid window). Every 5 minutes rather than the 15-minute cadence
--    expire_reschedule_holds()/expire_cancellation_holds() use — this hold
--    window (30-60 min, default 45) is far shorter than theirs (48h
--    default), so a 15-minute check interval would be a much larger
--    relative slippage here.
-- ============================================================
create or replace function public.expire_reservation_extensions()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  ext record;
begin
  for ext in
    select re.extension_id, re.reservation_id, r.user_id
    from public.reservation_extensions re
    join public.reservations r on r.reservation_id = re.reservation_id
    where re.status = 'pending_payment'
      and re.hold_expires_at is not null
      and re.hold_expires_at < now()
  loop
    update public.reservation_extensions
    set status = 'expired', decided_at = now()
    where extension_id = ext.extension_id;

    if ext.user_id is not null then
      insert into public.notifications (user_id, type, title, body, link)
      values (
        ext.user_id,
        'reservation_status',
        'Extension Request Expired',
        'Your extension request expired before payment was submitted. You can request another extension any time if time is still available.',
        '/reservation-details.html?reservation_id=' || ext.reservation_id
      );
    end if;
  end loop;
end;
$$;

grant execute on function public.expire_reservation_extensions() to service_role;

select cron.unschedule(jobid) from cron.job where jobname = 'expire-reservation-extensions';
select cron.schedule(
  'expire-reservation-extensions',
  '*/5 * * * *',
  $$select public.expire_reservation_extensions();$$
);

-- ============================================================
-- 8. Every scheduling function that reads/writes a reservation's blocked
--    time is extended here — full bodies reproduced verbatim from their
--    current source (20260909_reschedule_hold_and_cancellation_debt.sql),
--    same convention that file itself used, with only the extension-aware
--    additions marked below. This is the ONLY place event_end_time's
--    computation changes; every other reader (board_reservations_view,
--    js/admin_reservations.js, js/board.js) already just selects that
--    column as-is, so making it always include approved extension hours
--    here is what makes an approved extension show up correctly on the
--    public calendar, the admin calendar, AND the Operations Board with no
--    separate fix needed on any of those three surfaces.
-- ============================================================

-- 8a. enforce_reservation_capacity(): end-time calc now adds approved
--     extension hours (self-healing — recomputed on every INSERT/UPDATE,
--     so it can never drift even if something updates the row for an
--     unrelated reason), and its overlap-EXISTS check now also rejects a
--     new/edited reservation landing on another reservation's pending
--     extension hold. The daily-capacity-cap check below it is
--     deliberately untouched — see count_held_extension_conflicts()'s own
--     comment for why an extension must never count against daily
--     capacity.
create or replace function public.enforce_reservation_capacity()
returns trigger
as $$
declare
  v_package_name text;
  v_package_location_type text;
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
  v_capacity integer := 2;
  v_scope_override integer;
  v_daily_count integer;
  v_held_daily_count integer;
  v_approved_extension_hours numeric := 0;
begin
  select p.package_name, p.location_type, coalesce(p.duration_hours, 3), p.price, p.min_guests, p.max_guests, p.is_active
  into v_package_name, v_package_location_type, v_duration_hours, v_package_price, v_package_min_guests, v_package_max_guests, v_package_is_active
  from public.package p
  where p.package_id = new.package_id;

  -- ── Package integrity (Reservation Form ↔ Admin Inventory single source) ──
  if (
    tg_op = 'INSERT'
    or new.package_id is distinct from old.package_id
    or new.add_on_id is distinct from old.add_on_id
    or new.guest_count is distinct from old.guest_count
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

      if new.total_price < (coalesce(v_package_price, 0) + coalesce(v_addon_price, 0)) then
        raise exception using errcode = 'P0001',
          message = 'Total price cannot be less than the selected package price.';
      end if;
    end if;

  end if;

  -- ── Scheduling / capacity ──────────
  v_scope := public.normalize_booking_scope(new.location_type, v_package_name);
  new.booking_scope := v_scope;

  v_start_time := public.parse_event_time_text(new.event_time);

  -- Extension Hours: fold in every APPROVED extension's hours so
  -- event_end_time always reflects the reservation's true effective end
  -- time, regardless of what triggered this recompute (a brand-new
  -- reservation has none yet; an unrelated field edit on an already-
  -- extended reservation must not silently reset it back to the bare
  -- package duration).
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
  ) or public.count_held_reschedule_conflicts(
    new.event_date, v_scope, v_start_time, v_end_time, 0,
    coalesce(new.reservation_id, '00000000-0000-0000-0000-000000000000'::uuid)
  ) > 0 or public.count_held_extension_conflicts(
    new.event_date, v_scope, v_start_time, v_end_time, 0,
    coalesce(new.reservation_id, '00000000-0000-0000-0000-000000000000'::uuid)
  ) > 0 then
    raise exception using
      errcode = 'P0001',
      message = 'This reservation overlaps an existing booking for the selected date and scope.';
  end if;

  -- Daily capacity cap — unchanged (extensions never count here; see
  -- count_held_extension_conflicts()'s own header comment).
  select default_slot_capacity
  into v_capacity
  from public.scheduling_settings where id = true;
  v_capacity := coalesce(v_capacity, 2);

  select capacity into v_scope_override from public.scope_capacity where scope = v_scope;
  v_capacity := coalesce(v_scope_override, v_capacity);

  select count(*)
  into v_daily_count
  from public.reservations r
  left join public.package rp on rp.package_id = r.package_id
  where r.event_date = new.event_date
    and lower(coalesce(r.status, '')) in ('pending', 'approved', 'confirmed', 'rescheduled')
    and coalesce(r.booking_scope, public.normalize_booking_scope(r.location_type, rp.package_name)) = v_scope
    and r.reservation_id <> coalesce(new.reservation_id, '00000000-0000-0000-0000-000000000000'::uuid);

  v_held_daily_count := public.count_held_reschedule_conflicts(
    new.event_date, v_scope, null, null, 0,
    coalesce(new.reservation_id, '00000000-0000-0000-0000-000000000000'::uuid)
  );

  if coalesce(v_daily_count, 0) + coalesce(v_held_daily_count, 0) >= v_capacity then
    v_scope_label := case v_scope
      when 'onsite_vip' then 'VIP'
      when 'onsite_main_hall' then 'Main Hall'
      when 'offsite' then 'Off-site'
      else 'Selected'
    end;
    v_event_label := to_char(new.event_date::timestamp, 'FMMonth DD, YYYY');

    raise exception using
      errcode = 'P0001',
      message = v_scope_label || ' has reached its daily booking limit for ' || v_event_label || '.';
  end if;

  return new;
end;
$$ language plpgsql;

-- 8b. enforce_reschedule_capacity(): its own overlap-EXISTS check now also
--     rejects a reschedule landing on another reservation's pending
--     extension hold. Daily-count check untouched, same reasoning as 8a.
create or replace function public.enforce_reschedule_capacity()
returns trigger
as $$
declare
  v_reservation         public.reservations%rowtype;
  v_package_name        text;
  v_duration_hours      integer := 3;
  v_scope               text;
  v_start_time          time;
  v_end_time            time;
  v_weekday             integer;
  v_is_open             boolean;
  v_weekday_label       text;
  v_buffer_minutes      integer := 30;
  v_capacity            integer := 2;
  v_scope_override      integer;
  v_padded_start        time;
  v_padded_end          time;
  v_overlap_count       integer;
  v_daily_count         integer;
  v_scope_label         text;
  v_rules_json          jsonb;
  v_min_advance_days    integer := 14;
  v_max_advance_days    integer := 365;
  v_event_type_override integer;
  v_days_until          integer;
begin
  if lower(coalesce(new.status, 'pending')) in ('rejected', 'completed', 'withdrawn', 'expired') then
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

  select ss.setting_value::jsonb into v_rules_json
  from public.system_settings ss
  where ss.setting_key = 'reservation_rules';

  v_min_advance_days := coalesce((v_rules_json->>'min_advance_days')::integer, 14);
  v_max_advance_days := coalesce((v_rules_json->>'max_advance_days')::integer, 365);

  select et.min_advance_days into v_event_type_override
  from public.event_types et
  where et.name = v_reservation.event_type;

  v_min_advance_days := coalesce(v_event_type_override, v_min_advance_days);

  v_days_until := new.requested_date - current_date;

  if v_days_until < v_min_advance_days then
    raise exception using
      errcode = 'P0001',
      message = 'This date is too soon — please choose a date at least ' || v_min_advance_days || ' day(s) from today.';
  end if;

  if v_days_until > v_max_advance_days then
    raise exception using
      errcode = 'P0001',
      message = 'This date is too far in advance — please choose a date within ' || v_max_advance_days || ' days from today.';
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

    v_scope_label := case v_scope
      when 'onsite_vip' then 'VIP'
      when 'onsite_main_hall' then 'Main Hall'
      when 'offsite' then 'Off-site'
      else 'Selected'
    end;

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

    -- Also count another customer's still-held reschedule request, and
    -- another reservation's still-held extension request, landing on this
    -- same slot.
    v_overlap_count := v_overlap_count + public.count_held_reschedule_conflicts(
      new.requested_date, v_scope, v_start_time, v_end_time, v_buffer_minutes, v_reservation.reservation_id
    ) + public.count_held_extension_conflicts(
      new.requested_date, v_scope, v_start_time, v_end_time, v_buffer_minutes, v_reservation.reservation_id
    );

    if v_overlap_count > 0 then
      raise exception using
        errcode = 'P0001',
        message = v_scope_label || ' is already booked at that time.';
    end if;

    select count(*)
    into v_daily_count
    from public.reservations r
    left join public.package rp on rp.package_id = r.package_id
    where r.event_date = new.requested_date
      and public.is_capacity_blocking_reservation_status(r.status)
      and r.reservation_id <> v_reservation.reservation_id
      and coalesce(r.booking_scope, public.normalize_booking_scope(r.location_type, rp.package_name)) = v_scope;

    v_daily_count := v_daily_count + public.count_held_reschedule_conflicts(
      new.requested_date, v_scope, p_exclude_reservation_id => v_reservation.reservation_id
    );

    if v_daily_count >= v_capacity then
      raise exception using
        errcode = 'P0001',
        message = v_scope_label || ' has reached its daily booking limit for that date.';
    end if;
  end if;

  return new;
end;
$$ language plpgsql;

-- 8c. get_available_start_times(): the customer-facing calendar's per-slot
--     overlap computation now also treats another reservation's pending
--     extension hold as occupying that time. Full body reproduced verbatim
--     from 20260909_reschedule_hold_and_cancellation_debt.sql §6 with only
--     that one addition (marked below) — everything else, including the
--     daily-capacity block above it, is unchanged.
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
  v_daily_count      integer;
  v_held_count       integer;
  v_capacity_reached boolean;
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

  -- Daily cap — unaffected by extensions, see count_held_extension_
  -- conflicts()'s header comment.
  if p_scope is not null then
    select count(*)
    into v_daily_count
    from public.reservations r
    left join public.package rp on rp.package_id = r.package_id
    where r.event_date = p_event_date
      and public.is_capacity_blocking_reservation_status(r.status)
      and (p_exclude_reservation_id is null or r.reservation_id <> p_exclude_reservation_id)
      and coalesce(r.booking_scope, public.normalize_booking_scope(r.location_type, rp.package_name)) = p_scope;

    v_held_count := public.count_held_reschedule_conflicts(p_event_date, p_scope, p_exclude_reservation_id => p_exclude_reservation_id);

    v_daily_count := coalesce(v_daily_count, 0) + coalesce(v_held_count, 0);
  else
    v_daily_count := 0;
  end if;
  v_capacity_reached := (p_scope is not null) and (v_daily_count >= v_capacity);

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
        )
        +
        public.count_held_reschedule_conflicts(
          p_event_date, p_scope,
          s.slot_start, (s.slot_start + make_interval(hours => v_duration))::time,
          v_buffer_minutes, p_exclude_reservation_id
        )
        +
        -- Extension Hours: a pending extension hold on another reservation
        -- occupies its held range the same way a pending reschedule hold
        -- does above.
        public.count_held_extension_conflicts(
          p_event_date, p_scope,
          s.slot_start, (s.slot_start + make_interval(hours => v_duration))::time,
          v_buffer_minutes, p_exclude_reservation_id
        )
      ) as overlap_count
    from slots s
  )
  select
    to_char(p_event_date + ss.slot_start, 'FMHH12:MI AM'),
    ss.slot_start,
    (ss.slot_start + make_interval(hours => v_duration))::time,
    (p_scope is not null and not v_capacity_reached and ss.overlap_count = 0),
    case
      when p_scope is null then 'Select a package first.'
      when v_capacity_reached then 'This scope has reached its daily booking limit for this date.'
      when ss.overlap_count > 0 then 'Unavailable due to another reservation.'
      else null
    end
  from slot_status ss
  order by ss.slot_start;
end;
$$;

grant execute on function public.get_available_start_times(date, text, integer, uuid) to anon, authenticated;

-- ============================================================
-- 9. reservation_payment_summary (20260725_payment_ledger.sql §3) excludes
--    cancellation_fee/reschedule_fee from total_paid/computed_status —
--    without adding extension_fee to that same exclusion list, an approved
--    extension payment would inflate total_paid and could flip a
--    reservation's computed_status to "overpaid" even though the package
--    itself isn't paid any more than before. Full view body reproduced
--    verbatim from that migration with only this one addition, same
--    convention section 8 above already used for the trigger functions.
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
    and pay.payment_type not in ('cancellation_fee', 'reschedule_fee', 'extension_fee')
) p on true;

grant select on public.reservation_payment_summary to authenticated;

-- ============================================================
-- 10. Critical fix — the customer INSERT policy on public.payment
--     (20260912_payment_page_server_guard.sql, "customer insert own base
--     payment") whitelists payment_type explicitly and did not, and could
--     not have, included 'extension_fee' (this feature didn't exist yet).
--     Without this, RLS silently rejects every customer's extension-fee
--     payment submission — the whole request/pay/approve flow would be
--     unreachable from the client despite everything else in this file
--     being correct. Reproduced verbatim from that migration with only
--     'extension_fee' added to the payment_type list, same convention as
--     every other full-body reproduction in this file. This is additive
--     alongside whatever other (undocumented, live-only) customer INSERT
--     policy already exists on this table per that migration's own note —
--     PostgreSQL OR's multiple permissive policies together, so widening
--     this one can only ever grant more, never take anything away.
-- ============================================================
drop policy if exists "customer insert own base payment" on public.payment;
create policy "customer insert own base payment"
  on public.payment for insert
  with check (
    payment_type in ('reservation_fee', 'down_payment', 'full_payment', 'partial_payment', 'reschedule_fee', 'extension_fee')
    and payment_status = 'pending_review'
    and exists (
      select 1 from public.reservations r
      where r.reservation_id = payment.reservation_id
        and r.user_id = auth.uid()
    )
  );
