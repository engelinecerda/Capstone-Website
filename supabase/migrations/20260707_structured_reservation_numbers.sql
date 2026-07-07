-- ── Structured, sortable reservation numbers ──────────────────────────────────
-- Replaces the ad-hoc "first 8 chars of the reservation_id UUID" display value
-- (previously computed on the fly only in supabase/functions/generate-signed-
-- contract, never stored) with a real, stored, human-readable identifier:
--   ELI-YYMMDD-XXX
--   YYMMDD = the reservation's event_date (not the booking/submission date)
--   XXX    = zero-padded daily sequence number, scoped to that event_date
--
-- Note on "legacy" numbers: this codebase never actually persisted the old
-- hex-slice value anywhere — it was only ever shown transiently in a
-- confirmation message and baked into already-generated contract PDFs. Since
-- that value is a deterministic function of the immutable reservation_id
-- (upper(left(reservation_id::text, 8))), it can be *recomputed* rather than
-- restored, which is what the legacy_reservation_number backfill below does.
--
-- Note on triggers and reschedules: reschedule approval
-- (js/admin_reservations.js, handlePaymentReview) does
-- `UPDATE reservations SET event_date = ... WHERE reservation_id = ...` on
-- the SAME row. The trigger below is BEFORE INSERT only (guarded by
-- `WHEN (NEW.reservation_number IS NULL)`), so an approved reschedule never
-- touches reservation_number — the customer's original number stays stable.
-- The existing reschedule_requests table already serves as reschedule
-- history; no new table is introduced for that here.
--
-- Note on timezone: reservations.event_date is a plain `date` column (no
-- time-of-day or timezone component) — it's the calendar date the customer
-- picked, never derived from now(). There is no midnight-rollover conversion
-- to perform.
-- ─────────────────────────────────────────────────────────────────────────────

-- 1. Per-event-date sequence counter ──────────────────────────────────────────
-- RLS is enabled with no policies at all — this is a purely internal counter,
-- never queried directly by any client. Only generate_reservation_number()
-- (security definer, below) may touch it; that's what lets it be written to
-- from the reservations BEFORE INSERT trigger regardless of the calling
-- customer/admin role's own privileges.
create table if not exists public.reservation_number_counters (
  event_date     date    primary key,
  last_sequence  integer not null default 0
);

alter table public.reservation_number_counters enable row level security;

create or replace function public.generate_reservation_number(p_event_date date)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_seq       integer;
  v_date_part text;
  v_date      date := coalesce(p_event_date, current_date);
begin
  insert into public.reservation_number_counters (event_date, last_sequence)
  values (v_date, 1)
  on conflict (event_date)
  do update set last_sequence = reservation_number_counters.last_sequence + 1
  returning last_sequence into v_seq;

  v_date_part := to_char(v_date, 'YYMMDD');

  return 'ELI-' || v_date_part || '-' || lpad(v_seq::text, 3, '0');
end;
$$;


-- 2. New columns ───────────────────────────────────────────────────────────────
alter table public.reservations
  add column if not exists reservation_number text,
  add column if not exists legacy_reservation_number text;


-- 3. INSERT-only trigger ────────────────────────────────────────────────────────
create or replace function public.set_reservation_number()
returns trigger
language plpgsql
as $$
begin
  if new.reservation_number is null then
    new.reservation_number := public.generate_reservation_number(new.event_date);
  end if;
  return new;
end;
$$;

drop trigger if exists reservations_set_reservation_number on public.reservations;
create trigger reservations_set_reservation_number
before insert on public.reservations
for each row
execute function public.set_reservation_number();


-- 4. Backfill existing rows, chronologically, using the same counter function ──
-- (a set-based UPDATE would not guarantee the counter table is incremented in
-- event_date order, so this uses an explicit ordered loop instead.)
--
-- reservations_enforce_capacity fires on every UPDATE (not just changes to
-- event_date/time/status), so it would re-validate scheduling overlap for
-- this purely cosmetic backfill and can abort on any pre-existing overlapping
-- rows. The two notification triggers would likewise fire pointlessly for
-- every historical row. All three are disabled for just this backfill step.
alter table public.reservations disable trigger reservations_enforce_capacity;
alter table public.reservations disable trigger trg_notify_customer_reservation_status;
alter table public.reservations disable trigger trg_notify_admins_reservation;

do $$
declare
  r record;
begin
  for r in
    select reservation_id, event_date
    from public.reservations
    where reservation_number is null
    order by event_date asc nulls last, created_at asc
  loop
    update public.reservations
    set reservation_number = public.generate_reservation_number(r.event_date),
        legacy_reservation_number = upper(left(reservation_id::text, 8))
    where reservation_id = r.reservation_id;
  end loop;
end;
$$;

alter table public.reservations enable trigger reservations_enforce_capacity;
alter table public.reservations enable trigger trg_notify_customer_reservation_status;
alter table public.reservations enable trigger trg_notify_admins_reservation;


-- 5. Lock it down: NOT NULL + unique index, only now that every row has one ───
alter table public.reservations
  alter column reservation_number set not null;

create unique index if not exists reservations_reservation_number_key
  on public.reservations (reservation_number);
