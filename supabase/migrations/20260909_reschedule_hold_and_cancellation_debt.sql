-- update-v20 continuation: reschedule holds (with a real expiry + calendar
-- block) and cancellation debt that persists independently of the
-- reservation itself. See the "Reservation Rescheduling & Cancellation —
-- Business Rules" spec this implements.

-- ============================================================
-- 1. New config fields — same system_settings.payment_rules JSON blob the
--    existing fee/cancellation-notice fields already live in (see
--    js/admin_payment_options.js, js/super_admin_settings.js's
--    "Cancellation Notice Rules" card). No schema change needed for these
--    four; they're just new JSON keys with sane defaults applied at read
--    time by the functions below (coalesce), same pattern as every other
--    payment_rules field. cancellation_balance_grace_days isn't named in
--    the spec's own field table (§2) — the flow narrative (§7.1/§7.4)
--    needs a duration for it, so it's added here as the same kind of
--    field, defaulting to 7 days.
--
--      reschedule_hold_hours          (number, default 48)
--      reschedule_min_notice_days     (number, nullable — optional per spec §2)
--      max_reschedule_count           (number, default 2)
--      cancellation_balance_grace_days(number, default 7)
--      cancellation_hold_hours        (number, default 48) — added in §8 below,
--        payment-first cancellation: the reservation holds its date in
--        'cancellation_requested' until the fee is verified or this
--        deadline passes.

-- ============================================================
-- 2. Schema additions
-- ============================================================
alter table public.reservations
  add column if not exists reschedule_count integer not null default 0;

alter table public.reschedule_requests
  add column if not exists hold_expires_at timestamptz;

-- reschedule_requests_status_check predates this file (defined when the
-- table was first created) and was never widened as the status vocabulary
-- grew across this cycle — 'voided' (20260907_cancellation_supersedes_
-- reschedule.sql), 'withdrawn' (already RLS-permitted since
-- 20260908_remove_manager_approval.sql's own-row update policy, but never
-- actually reachable because the CHECK constraint rejected the write
-- first), and now 'expired' (this file, §7a). Recreated in full rather
-- than just appended to, same pattern as
-- reservation_contracts_review_status_check in
-- 20260825_remove_contract_resubmission.sql.
alter table public.reschedule_requests
  drop constraint if exists reschedule_requests_status_check;
alter table public.reschedule_requests
  add constraint reschedule_requests_status_check
  check (status in (
    'pending', 'approved_pending_payment', 'completed',
    'rejected', 'voided', 'withdrawn', 'expired'
  ));

-- ============================================================
-- 2b. reservation_cancellations has never had an INSERT policy for
--     customers — it was created (20260418_add_reservation_cancellations.sql)
--     alongside a SECURITY DEFINER RPC, cancel_own_reservation(), that did
--     the insert itself (bypassing RLS), and the only policies added since
--     are SELECT-only. The cancel-then-bill rewrite (js/account.js,
--     js/reservation_details.js) inserts into this table directly from
--     the client instead of calling that RPC, which has been failing with
--     "new row violates row-level security policy" ever since — nothing
--     ever granted a customer permission to write their own cancellation
--     record. Mirrors the shape of "insert own reservation status
--     history" (20260418_fix_reservation_status_rls.sql) and "customer
--     insert own cancellation fee" (20260908_remove_manager_approval.sql).
-- ============================================================
grant insert on public.reservation_cancellations to authenticated;

drop policy if exists "customer insert own cancellation record" on public.reservation_cancellations;
create policy "customer insert own cancellation record"
  on public.reservation_cancellations for insert
  with check (
    auth.uid() = user_id
    and exists (
      select 1 from public.reservations r
      where r.reservation_id = reservation_cancellations.reservation_id
        and r.user_id = auth.uid()
    )
  );

-- ============================================================
-- 3. Reschedule submission: set the hold expiry server-side (never trust
--    the client's clock for this), and enforce the two new eligibility
--    gates from spec §4 that enforce_reschedule_capacity() didn't cover
--    before: reschedule_min_notice_days (notice before the *original*
--    event date — distinct from the existing advance-notice check on the
--    *requested* date) and max_reschedule_count.
-- ============================================================
create or replace function public.set_reschedule_hold_expiry()
returns trigger
language plpgsql
as $$
declare
  v_rules_json    jsonb;
  v_hold_hours    numeric := 48;
  v_min_notice    integer;
  v_max_count     integer := 2;
  v_reservation   public.reservations%rowtype;
  v_days_until_event integer;
begin
  if tg_op <> 'INSERT' then
    return new;
  end if;

  select r.* into v_reservation
  from public.reservations r
  where r.reservation_id = new.reservation_id;

  if v_reservation.reservation_id is null then
    return new;
  end if;

  select ss.setting_value::jsonb into v_rules_json
  from public.system_settings ss
  where ss.setting_key = 'payment_rules';

  v_hold_hours := coalesce((v_rules_json->>'reschedule_hold_hours')::numeric, 48);
  v_min_notice := (v_rules_json->>'reschedule_min_notice_days')::integer;
  v_max_count  := coalesce((v_rules_json->>'max_reschedule_count')::integer, 2);

  -- Reservation must still be an active, reschedulable state — not already
  -- cancelled/completed/declined.
  if not public.is_capacity_blocking_reservation_status(v_reservation.status) then
    raise exception using
      errcode = 'P0001',
      message = 'This reservation is no longer eligible for a reschedule.';
  end if;

  -- Only one open reschedule request per reservation at a time.
  -- reschedule_count (checked below) only increments on completion, so a
  -- still-open request (awaiting fee payment, hold not yet expired) never
  -- counts against max_reschedule_count — without this check a customer
  -- could stack a second concurrent request on top of an unresolved one.
  -- computeCanReschedule() in js/reservation_shared.js already hides the
  -- "Request Reschedule" button client-side for this same case; this is
  -- the server-side backstop it was missing.
  if exists (
    select 1
    from public.reschedule_requests existing
    where existing.reservation_id = new.reservation_id
      and lower(coalesce(existing.status, '')) in ('pending', 'approved_pending_payment')
      and (existing.hold_expires_at is null or existing.hold_expires_at > now())
  ) then
    raise exception using
      errcode = 'P0001',
      message = 'You already have an open reschedule request for this reservation — withdraw it or wait for it to be resolved before requesting another.';
  end if;

  -- Notice before the ORIGINAL event date (distinct from the existing
  -- advance-notice check in enforce_reschedule_capacity(), which validates
  -- the REQUESTED date relative to today — this validates how close today
  -- already is to the CURRENT booked date).
  if v_min_notice is not null then
    v_days_until_event := v_reservation.event_date - current_date;
    if v_days_until_event < v_min_notice then
      raise exception using
        errcode = 'P0001',
        message = 'Reschedule requests must be made at least ' || v_min_notice || ' day(s) before your event.';
    end if;
  end if;

  if v_reservation.reschedule_count >= v_max_count then
    raise exception using
      errcode = 'P0001',
      message = 'This reservation has reached its reschedule limit — please contact us directly.';
  end if;

  -- make_interval()'s hours parameter is integer-only — passing v_hold_hours
  -- (numeric, since the admin field allows e.g. "1.5" hours) directly fails
  -- with "function make_interval(hours => numeric) does not exist" the
  -- first time this trigger actually runs (CREATE FUNCTION doesn't catch
  -- this; plpgsql only resolves overloads at execution). Converting to
  -- seconds instead avoids truncating fractional hours to whole ones.
  new.hold_expires_at := now() + make_interval(secs => v_hold_hours * 3600);
  return new;
end;
$$;

drop trigger if exists trg_set_reschedule_hold_expiry on public.reschedule_requests;
create trigger trg_set_reschedule_hold_expiry
before insert on public.reschedule_requests
for each row execute function public.set_reschedule_hold_expiry();

-- ============================================================
-- 4. Increment reschedule_count only when a reschedule actually finalizes
--    (fee paid, date moves) — not on request, not on an expired hold. The
--    finalize step already exists (js/admin_payments.js's
--    handlePaymentReview, on reschedule_fee approval) and sets
--    reschedule_requests.status = 'completed' as part of that same
--    update — increment from there via trigger so the count can never
--    drift out of sync with what actually got finalized, regardless of
--    which code path performs the update.
-- ============================================================
create or replace function public.increment_reschedule_count_on_completion()
returns trigger
language plpgsql
as $$
begin
  if new.status = 'completed' and old.status is distinct from new.status then
    update public.reservations
    set reschedule_count = reschedule_count + 1
    where reservation_id = new.reservation_id;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_increment_reschedule_count on public.reschedule_requests;
create trigger trg_increment_reschedule_count
after update on public.reschedule_requests
for each row execute function public.increment_reschedule_count_on_completion();

-- One-time backfill: reschedule_count is a brand-new column starting at 0
-- for every reservation, and the trigger above only fires on a FUTURE
-- transition to 'completed'. Any reschedule that already finalized before
-- this migration first ran left its reservation's count at 0 forever,
-- silently exempting it from max_reschedule_count. 'completed' has been
-- the one terminal-success status for reschedule_requests since it was
-- first introduced, so counting it directly is safe and complete. Re-run
-- safe: only raises rows whose stored count is under the true count.
update public.reservations r
set reschedule_count = sub.cnt
from (
  select reservation_id, count(*) as cnt
  from public.reschedule_requests
  where status = 'completed'
  group by reservation_id
) sub
where r.reservation_id = sub.reservation_id
  and r.reschedule_count < sub.cnt;

-- ============================================================
-- 5. Cancellation debt as a booking gate — block a NEW reservation while
--    the customer has a cancelled reservation with no APPROVED
--    cancellation_fee payment yet. No grace period here — spec §7.3's
--    block is immediate and unconditional; the grace period (below, §7.4)
--    only controls when the *manager* gets escalated for follow-up, not
--    when the customer gets blocked.
--
--    Keyed off reservations.status rather than the payment table, because
--    a cancellation_fee `payment` row now only ever exists once the
--    customer actually submits proof through the normal payment flow
--    (js/payment.js) — same as every other payment type in this app.
--    There is no separate system-generated "debt marker" row anymore (see
--    js/account.js's submitCancellationRequest comment): one used to be
--    auto-inserted as pending_review at cancellation time, but that
--    silently satisfied getAvailablePaymentOptions'/isCancellationFeeOwed's
--    "already submitted" check before the customer ever got to submit a
--    real one, making "Continue Payment" permanently unreachable.
-- ============================================================
create or replace function public.block_booking_with_unresolved_cancellation_debt()
returns trigger
language plpgsql
as $$
declare
  v_owed numeric;
begin
  if tg_op <> 'INSERT' then
    return new;
  end if;

  select count(*) into v_owed
  from public.reservations r
  where r.user_id = new.user_id
    and r.status = 'cancelled'
    and not exists (
      select 1 from public.payment p
      where p.reservation_id = r.reservation_id
        and p.payment_type = 'cancellation_fee'
        and lower(coalesce(p.payment_status, '')) = 'approved'
    );

  if v_owed > 0 then
    raise exception using
      errcode = 'P0001',
      message = 'You have an outstanding balance from a previous cancellation — please settle it before booking again.';
  end if;

  return new;
end;
$$;

drop trigger if exists trg_block_booking_with_cancellation_debt on public.reservations;
create trigger trg_block_booking_with_cancellation_debt
before insert on public.reservations
for each row execute function public.block_booking_with_unresolved_cancellation_debt();

-- ============================================================
-- 6. Held reschedule requests must occupy their requested date/scope the
--    same way a real reservation does — otherwise a second customer can
--    book (or reschedule into) a date another customer already has on
--    hold awaiting fee payment.
--
--    get_available_start_times() (the customer-facing calendar's own
--    availability source), enforce_reschedule_capacity() (the INSERT-time
--    trigger on reschedule_requests), and enforce_reservation_capacity()
--    (the INSERT/UPDATE-time trigger on reservations) each run their OWN
--    separate inline overlap/daily-count queries against public.
--    reservations — none of them call each other. All three need the
--    same "also count held reschedule_requests" addition, so it's factored
--    into one shared function here instead of copy-pasted three times
--    (the exact kind of duplication that's already drifted out of sync
--    more than once in this codebase this cycle).
create or replace function public.count_held_reschedule_conflicts(
  p_date                   date,
  p_scope                  text,
  p_slot_start             time default null,
  p_slot_end               time default null,
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
  from public.reschedule_requests rr
  join public.reservations res on res.reservation_id = rr.reservation_id
  left join public.package resp on resp.package_id = res.package_id
  where rr.requested_date = p_date
    and rr.status = 'approved_pending_payment'
    and rr.hold_expires_at > now()
    and (p_exclude_reservation_id is null or rr.reservation_id <> p_exclude_reservation_id)
    and coalesce(res.booking_scope, public.normalize_booking_scope(res.location_type, resp.package_name)) = p_scope
    and (
      p_slot_start is null
      or public.booking_times_overlap(
        (p_slot_start - make_interval(mins => p_buffer_minutes))::time,
        (p_slot_end + make_interval(mins => p_buffer_minutes))::time,
        public.parse_event_time_text(rr.requested_time),
        (
          public.parse_event_time_text(rr.requested_time)
          + make_interval(hours => coalesce(resp.duration_hours, 3))
        )::time
      )
    );
$$;
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

  -- Daily cap — how many separate bookings this scope already holds today
  -- (real reservations), plus any still-held reschedule requests targeting
  -- this date/scope that haven't expired.
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

-- Same held-reschedule extension for the two INSERT/UPDATE-time triggers
-- that do their own separate capacity checks (see the comment on section 6
-- above) — full bodies reproduced verbatim from their source migrations
-- (20260813_reschedule_advance_notice.sql,
-- 20260803_reservation_location_type_integrity.sql) with only the two
-- capacity checks in each extended.
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
  -- 'withdrawn' (update-v20) was missing from this skip-list, so a
  -- withdrawal re-ran the entire capacity/advance-notice validation below
  -- as if it were a brand-new request — including the reservations lookup
  -- and count_held_reschedule_conflicts() call, neither of which a plain
  -- customer-invoked (non-security-definer) trigger has cross-customer
  -- visibility to run, surfacing as "permission denied for table
  -- reservations" instead of the intended terminal, always-allowed
  -- withdraw. Withdrawing should never be capacity-gated.
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

  -- Advance-notice window: minimum days from today (with a per-event-type
  -- override taking priority over the site-wide default) and maximum days
  -- from today. Mirrors js/reservation_availability.js's
  -- getEffectiveMinAdvanceDays/isOutsideBookingWindow exactly.
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

    -- Also count another customer's still-held reschedule request landing
    -- on this same slot — see count_held_reschedule_conflicts() above.
    v_overlap_count := v_overlap_count + public.count_held_reschedule_conflicts(
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
        message = v_scope_label || ' has reached its daily booking limit for this date.';
    end if;
  end if;

  return new;
end;
$$ language plpgsql;

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
  ) or public.count_held_reschedule_conflicts(
    new.event_date, v_scope, v_start_time, v_end_time, 0,
    coalesce(new.reservation_id, '00000000-0000-0000-0000-000000000000'::uuid)
  ) > 0 then
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
  ) or public.count_held_reschedule_conflicts(
    new.event_date, v_scope, null, null, 0,
    coalesce(new.reservation_id, '00000000-0000-0000-0000-000000000000'::uuid)
  ) > 0 then
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
$$ language plpgsql;

-- ============================================================
-- 7. Scheduled jobs — same pg_cron pattern already running hourly for
--    auto_cancel_overdue_reservations() (20260716_payment_overhaul.sql).
-- ============================================================

-- 7a. Expire timed-out reschedule holds. Notifies the customer (reuses
--     the notifications table every other customer-facing event in this
--     app already uses) and leaves the original reservation exactly as it
--     was — it was never touched.
create or replace function public.expire_reschedule_holds()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  req record;
begin
  for req in
    select rr.reschedule_request_id, rr.reservation_id, rr.requested_date, r.user_id
    from public.reschedule_requests rr
    join public.reservations r on r.reservation_id = rr.reservation_id
    where rr.status = 'approved_pending_payment'
      and rr.hold_expires_at is not null
      and rr.hold_expires_at < now()
  loop
    update public.reschedule_requests
    set status = 'expired', reviewed_at = now()
    where reschedule_request_id = req.reschedule_request_id;

    if req.user_id is not null then
      insert into public.notifications (user_id, type, title, body, link)
      values (
        req.user_id,
        'reservation_status',
        'Reschedule Hold Expired',
        'Your hold on ' || to_char(req.requested_date::timestamp, 'FMMonth DD, YYYY') || ' expired before the fee was paid. Your original date is unaffected — you can request a new reschedule any time.',
        '/account.html'
      );
    end if;
  end loop;
end;
$$;

grant execute on function public.expire_reschedule_holds() to service_role;

select cron.unschedule(jobid) from cron.job where jobname = 'expire-reschedule-holds';
select cron.schedule(
  'expire-reschedule-holds',
  '*/15 * * * *',
  $$select public.expire_reschedule_holds();$$
);

-- 7b. Flag cancellation balances that have sat unresolved past the grace
--     period — visibility only (no automated collection, there's no
--     payment gateway to trigger it), notifying managers once per balance
--     via the same reminder_sent dedup table 20260815_reminder_
--     notifications.sql already established for the analogous unpaid-
--     reservation-balance reminders, so this never re-notifies daily.
--     reminder_sent's unique key is (reservation_id, reminder_type,
--     target_date) — target_date is pinned to an anchor timestamp that
--     never changes for a given unresolved balance, so this stays a
--     genuine one-time flag per balance rather than re-firing every day
--     target_date would otherwise roll forward.
--     Manager fan-out mirrors notify_admins_on_reservation()'s existing
--     "insert ... select user_id ... from profiles where role = 'manager'"
--     pattern (20260820_admin_notification_scoping.sql) — notifications
--     has no audience/role column, one row per recipient is how every
--     other manager-wide notice in this app already works.
--
--     Base set is now reservations.status = 'cancelled' rather than the
--     payment table, since a cancellation_fee `payment` row may not exist
--     at all yet (see block_booking_with_unresolved_cancellation_debt's
--     comment above — the customer may simply never have submitted one).
--     The grace-period anchor falls back to reservation_cancellations.
--     cancelled_at for that case, or the latest pending_review/rejected
--     submission's submitted_at if one exists; the fee amount falls back
--     to the same computed onsite/offsite lookup used elsewhere in this
--     file when no payment row exists to read an amount from.
create or replace function public.flag_overdue_cancellation_balances()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_rules_json  jsonb;
  v_grace_days  integer := 7;
  bal record;
begin
  select ss.setting_value::jsonb into v_rules_json
  from public.system_settings ss
  where ss.setting_key = 'payment_rules';
  v_grace_days := coalesce((v_rules_json->>'cancellation_balance_grace_days')::integer, 7);

  for bal in
    select
      r.reservation_id,
      r.contact_name,
      coalesce(
        p.amount,
        case when lower(coalesce(r.location_type, '')) = 'offsite' then
          coalesce((v_rules_json->>'cancellation_fee_offsite')::numeric, 2000)
        else
          coalesce((v_rules_json->>'cancellation_fee_onsite')::numeric, 500)
        end
      ) as amount,
      coalesce(p.submitted_at, rc.cancelled_at) as anchor_at
    from public.reservations r
    join public.reservation_cancellations rc on rc.reservation_id = r.reservation_id
    left join lateral (
      select amount, submitted_at
      from public.payment
      where reservation_id = r.reservation_id
        and payment_type = 'cancellation_fee'
        and lower(coalesce(payment_status, '')) in ('pending_review', 'rejected')
      order by submitted_at desc
      limit 1
    ) p on true
    where r.status = 'cancelled'
      and not exists (
        select 1 from public.payment ap
        where ap.reservation_id = r.reservation_id
          and ap.payment_type = 'cancellation_fee'
          and lower(coalesce(ap.payment_status, '')) = 'approved'
      )
      and coalesce(p.submitted_at, rc.cancelled_at) < now() - make_interval(days => v_grace_days)
      and not exists (
        select 1 from public.reminder_sent rs
        where rs.reservation_id = r.reservation_id
          and rs.reminder_type = 'cancellation_balance_overdue'
          and rs.target_date = coalesce(p.submitted_at, rc.cancelled_at)::date
      )
  loop
    insert into public.reminder_sent (reservation_id, reminder_type, target_date)
    values (bal.reservation_id, 'cancellation_balance_overdue', bal.anchor_at::date);

    insert into public.notifications (user_id, type, title, body, link)
    select user_id, 'payment_overdue',
           'Overdue Cancellation Balance',
           coalesce(bal.contact_name, 'A customer') || ' has an unpaid cancellation fee of ' || bal.amount::text || ' past the grace period.',
           '/admin/payments.html?reservation=' || bal.reservation_id
    from public.profiles
    where role = 'manager';
  end loop;
end;
$$;

grant execute on function public.flag_overdue_cancellation_balances() to service_role;

select cron.unschedule(jobid) from cron.job where jobname = 'flag-overdue-cancellation-balances';
select cron.schedule(
  'flag-overdue-cancellation-balances',
  '0 8 * * *',
  $$select public.flag_overdue_cancellation_balances();$$
);

-- ============================================================
-- 8. Payment-first cancellation (supersedes §5/§7b's "cancel instantly,
--    bill later" model, per explicit business decision after this file
--    first shipped: a cancellation must not be considered final until its
--    fee is verified). Mirrors the reschedule hold exactly, just applied
--    to the CURRENT date instead of a new one — 'cancellation_requested'
--    (already a status this app has always recognized; simply unused
--    since the earlier cancel-then-bill rewrite) holds the reservation's
--    own date via is_capacity_blocking_reservation_status below, with a
--    deadline for the fee to be verified. Two ways out, both terminal:
--      - the fee payment is APPROVED by a manager (mirrors the reschedule
--        fee's own approval-finalizes pattern exactly, not mere
--        submission) -> finalize_cancellation_on_fee_approval() below.
--      - the hold_expires_at deadline passes unpaid -> expire_
--        cancellation_holds() below finalizes it anyway (date still
--        releases), and the now-cancelled reservation's unpaid fee is
--        picked up by the existing §5 booking-block trigger exactly like
--        any other unresolved cancellation debt.
--    Withdrawing (js/account.js, js/reservation_details.js) is a plain
--    client update back to pre_cancellation_status — already covered by
--    the existing "update own reservations" RLS policy (20260418_allow_
--    reservation_updates.sql has no column/value restriction), so no new
--    policy is needed for that path.
-- ============================================================
alter table public.reservations
  add column if not exists cancellation_hold_expires_at timestamptz;
alter table public.reservations
  add column if not exists pre_cancellation_status text;

-- A pending cancellation still occupies its date/time — the whole point
-- of the hold is that the slot isn't released until the fee is resolved
-- one way or the other.
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
    'rescheduled',
    'cancellation_requested'
  )
$$;

-- Sets the deadline server-side (never trust the client's clock) whenever
-- a reservation transitions INTO 'cancellation_requested', and stashes
-- the status being left behind so withdraw/expiry/finalize can restore or
-- reference it without a second lookup. Re-requesting while already
-- cancellation_requested, or requesting from any non-active status, is
-- rejected here as a server-side backstop to computeCanCancel's own
-- client-side gate (js/reservation_shared.js).
create or replace function public.set_cancellation_hold_expiry()
returns trigger
language plpgsql
as $$
declare
  v_rules_json jsonb;
  v_hold_hours numeric := 48;
begin
  if new.status is distinct from 'cancellation_requested' or old.status = 'cancellation_requested' then
    return new;
  end if;

  if lower(coalesce(old.status, '')) not in ('approved', 'confirmed', 'rescheduled') then
    raise exception using
      errcode = 'P0001',
      message = 'This reservation is no longer eligible for cancellation.';
  end if;

  select ss.setting_value::jsonb into v_rules_json
  from public.system_settings ss
  where ss.setting_key = 'payment_rules';
  v_hold_hours := coalesce((v_rules_json->>'cancellation_hold_hours')::numeric, 48);

  new.pre_cancellation_status := old.status;
  -- Same make_interval(secs => ...) pattern as set_reschedule_hold_expiry()
  -- above — hours is integer-only, and the admin field allows fractional
  -- hours.
  new.cancellation_hold_expires_at := now() + make_interval(secs => v_hold_hours * 3600);
  return new;
end;
$$;

drop trigger if exists trg_set_cancellation_hold_expiry on public.reservations;
create trigger trg_set_cancellation_hold_expiry
before update on public.reservations
for each row execute function public.set_cancellation_hold_expiry();

-- Finalizes the cancellation the moment a manager approves the
-- cancellation_fee payment — mirrors js/admin_payments.js's reschedule_fee
-- approval handling, just server-side via trigger instead of client code,
-- so it can't be bypassed or duplicated by a different UI path. A
-- rejected fee leaves the reservation exactly as it was (still
-- cancellation_requested, still counting down) so the customer can
-- resubmit through the normal payment flow before the deadline.
create or replace function public.finalize_cancellation_on_fee_approval()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_reservation public.reservations%rowtype;
begin
  if new.payment_type is distinct from 'cancellation_fee'
     or lower(coalesce(new.payment_status, '')) is distinct from 'approved'
     or old.payment_status is not distinct from new.payment_status then
    return new;
  end if;

  select * into v_reservation
  from public.reservations
  where reservation_id = new.reservation_id
    and status = 'cancellation_requested';

  if v_reservation.reservation_id is null then
    return new;
  end if;

  update public.reservations
  set status = 'cancelled',
      cancellation_hold_expires_at = null
  where reservation_id = v_reservation.reservation_id;

  insert into public.reservation_status (reservation_id, previous_status, new_status, changed_at)
  values (v_reservation.reservation_id, 'cancellation_requested', 'cancelled', now());

  insert into public.reservation_cancellations (reservation_id, user_id, previous_status, reason, cancelled_at)
  values (
    v_reservation.reservation_id,
    v_reservation.user_id,
    coalesce(v_reservation.pre_cancellation_status, 'approved'),
    coalesce(v_reservation.cancellation_reason, 'Cancelled by customer'),
    now()
  )
  on conflict (reservation_id) do nothing;

  return new;
end;
$$;

drop trigger if exists trg_finalize_cancellation_on_fee_approval on public.payment;
create trigger trg_finalize_cancellation_on_fee_approval
after update on public.payment
for each row execute function public.finalize_cancellation_on_fee_approval();

-- Auto-finalizes any cancellation whose fee deadline passed unpaid (or
-- unverified) — same pg_cron cadence as expire_reschedule_holds() above.
-- The date releases either way; the debt itself is picked up afterward by
-- the existing §5 booking-block trigger since the reservation is now
-- genuinely 'cancelled' with no approved fee.
create or replace function public.expire_cancellation_holds()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  req record;
begin
  for req in
    select reservation_id, user_id, event_date, cancellation_reason, pre_cancellation_status
    from public.reservations
    where status = 'cancellation_requested'
      and cancellation_hold_expires_at is not null
      and cancellation_hold_expires_at < now()
  loop
    update public.reservations
    set status = 'cancelled',
        cancellation_hold_expires_at = null
    where reservation_id = req.reservation_id;

    insert into public.reservation_status (reservation_id, previous_status, new_status, changed_at)
    values (req.reservation_id, 'cancellation_requested', 'cancelled', now());

    insert into public.reservation_cancellations (reservation_id, user_id, previous_status, reason, cancelled_at)
    values (
      req.reservation_id,
      req.user_id,
      coalesce(req.pre_cancellation_status, 'approved'),
      coalesce(req.cancellation_reason, 'Cancelled by customer'),
      now()
    )
    on conflict (reservation_id) do nothing;

    if req.user_id is not null then
      insert into public.notifications (user_id, type, title, body, link)
      values (
        req.user_id,
        'reservation_status',
        'Cancellation Finalized',
        'The payment deadline for your cancellation fee passed before it was verified, so your reservation for ' || to_char(req.event_date::timestamp, 'FMMonth DD, YYYY') || ' has been finalized as cancelled and the date released. The fee is still owed before you can book again.',
        '/account.html'
      );
    end if;
  end loop;
end;
$$;

grant execute on function public.expire_cancellation_holds() to service_role;

select cron.unschedule(jobid) from cron.job where jobname = 'expire-cancellation-holds';
select cron.schedule(
  'expire-cancellation-holds',
  '*/15 * * * *',
  $$select public.expire_cancellation_holds();$$
);
