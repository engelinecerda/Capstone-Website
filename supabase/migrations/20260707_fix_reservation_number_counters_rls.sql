-- ── Fix RLS blocking reservation number generation ────────────────────────────
-- reservation_number_counters has no policies, so once RLS is enabled on it
-- (this project appears to auto-enable RLS on new tables) it's inaccessible
-- to the authenticated/anon roles that actually perform the customer-facing
-- INSERT into reservations. generate_reservation_number() is called from the
-- reservations BEFORE INSERT trigger and runs with the CALLING role's
-- privileges unless marked SECURITY DEFINER — matching the same pattern
-- already used by get_booking_availability() / get_available_start_times().
--
-- The table itself is explicitly locked down (RLS on, no policies at all) —
-- it's purely an internal counter, never queried directly by any client;
-- only this security-definer function needs to touch it.
-- ─────────────────────────────────────────────────────────────────────────────

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
