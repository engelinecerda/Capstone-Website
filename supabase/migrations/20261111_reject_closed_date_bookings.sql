-- Fix (MANAGER_RELIABILITY_18): a manager closing a date while a customer is
-- in the middle of booking the same date did not stop that booking.
--
-- Cause: calendar_blackouts (the table behind "Close date" on the Availability
-- Calendar) was only ever enforced in the browser — the booking form hides
-- closed dates, but nothing in the database re-checked them at submit time.
-- A customer who loaded the calendar before the manager closed the date could
-- still submit, and the manager then had to decline the booking by hand.
--
-- Fix: two small BEFORE triggers that reject the write when the date is
-- closed, so the customer gets an immediate "choose another date" message
-- instead of waiting for a decline:
--   * reservations         — new bookings, and any change to event_date
--   * reschedule_requests  — new reschedule requests (requested_date)
--
-- Deliberately NOT blocked:
--   * staff/manager/admin writes — a manager can still book or move a
--     reservation onto a closed date on purpose (e.g. a private event);
--   * system writes with no logged-in user (cron jobs, the SQL editor, seed
--     scripts);
--   * status-only updates to an existing reservation — closing a date never
--     blocks approving, completing or cancelling bookings already on it.
--
-- calendar_blackouts was created by hand in the SQL editor, so its date column
-- is 'closed_date' in the live project but 'date' in the original docs. The
-- helper below probes for both, in the same order the booking form does
-- (js/reservation_availability.js), instead of hard-coding one.

-- ── 1. Helper: is this calendar date closed? ───────────────────────────────
create or replace function public.is_calendar_date_closed(p_date date)
returns boolean
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_col    text;
  v_closed boolean := false;
begin
  if p_date is null then
    return false;
  end if;

  select c.column_name
    into v_col
    from information_schema.columns c
   where c.table_schema = 'public'
     and c.table_name = 'calendar_blackouts'
     and c.column_name in ('closed_date', 'date')
   order by case c.column_name when 'closed_date' then 0 else 1 end
   limit 1;

  if v_col is null then
    return false;  -- table/column not present: nothing is closed
  end if;

  execute format(
    'select exists (select 1 from public.calendar_blackouts where %I::date = $1)',
    v_col
  ) into v_closed using p_date;

  return coalesce(v_closed, false);
exception when others then
  -- A problem reading the blackout list must never block every booking.
  raise warning 'is_calendar_date_closed(%) could not read calendar_blackouts: %', p_date, sqlerrm;
  return false;
end;
$$;

revoke all on function public.is_calendar_date_closed(date) from public, anon;
grant execute on function public.is_calendar_date_closed(date) to authenticated;

-- ── 2. reservations: reject new bookings / date changes onto a closed date ──
create or replace function public.reject_closed_date_booking()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.event_date is null then
    return new;
  end if;

  -- Status-only or other updates that leave the date alone are never blocked.
  if tg_op = 'UPDATE' and new.event_date is not distinct from old.event_date then
    return new;
  end if;

  -- System writes (no logged-in user) and staff/manager/admin may still
  -- place a booking on a closed date on purpose.
  if auth.uid() is null
     or coalesce(public.get_my_role(), '') in ('manager', 'admin', 'staff') then
    return new;
  end if;

  if public.is_calendar_date_closed(new.event_date) then
    raise exception using errcode = 'P0001',
      message = 'Sorry, that date is no longer available for booking. Please choose a different date.',
      hint = 'date_closed';
  end if;

  return new;
end;
$$;

revoke all on function public.reject_closed_date_booking() from public, anon, authenticated;

drop trigger if exists reject_closed_date_booking on public.reservations;
create trigger reject_closed_date_booking
before insert or update of event_date on public.reservations
for each row execute function public.reject_closed_date_booking();

-- ── 3. reschedule_requests: same rule for the requested date ───────────────
create or replace function public.reject_closed_date_reschedule()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.requested_date is null then
    return new;
  end if;

  if auth.uid() is null
     or coalesce(public.get_my_role(), '') in ('manager', 'admin', 'staff') then
    return new;
  end if;

  if public.is_calendar_date_closed(new.requested_date) then
    raise exception using errcode = 'P0001',
      message = 'Sorry, that date is no longer available for booking. Please choose a different date.',
      hint = 'date_closed';
  end if;

  return new;
end;
$$;

revoke all on function public.reject_closed_date_reschedule() from public, anon, authenticated;

drop trigger if exists reject_closed_date_reschedule on public.reschedule_requests;
create trigger reject_closed_date_reschedule
before insert on public.reschedule_requests
for each row execute function public.reject_closed_date_reschedule();

notify pgrst, 'reload schema';

-- ── Verify (run after applying) ────────────────────────────────────────────
--   select tgname, tgrelid::regclass from pg_trigger
--    where tgname in ('reject_closed_date_booking', 'reject_closed_date_reschedule');
--   -- expect 2 rows
--
--   select public.is_calendar_date_closed(current_date + 30);
--   -- false for an open date; true for any date listed in calendar_blackouts
--
-- Roll back:
--   drop trigger if exists reject_closed_date_booking on public.reservations;
--   drop trigger if exists reject_closed_date_reschedule on public.reschedule_requests;
--   drop function if exists public.reject_closed_date_booking();
--   drop function if exists public.reject_closed_date_reschedule();
--   drop function if exists public.is_calendar_date_closed(date);
