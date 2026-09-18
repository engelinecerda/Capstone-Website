-- Fix: the Recent Changes banner reappears immediately after being
-- dismissed/reviewed.
--
-- Root cause: trg_reservations_set_updated_at (20260814_board_updated_at_
-- and_cancelled_visibility.sql) is an unconditional BEFORE UPDATE trigger
-- that sets reservations.updated_at = now() on every single update to the
-- row — including markReservationChangesSeen()'s own
-- `update reservations set change_seen_at = ...` call (js/
-- reservation_shared.js), which "Review" and the dismiss (X) button both
-- call to acknowledge the banner.
--
-- fetchUnseenReservationChanges() decides a reservation is still "unseen"
-- with `change_seen_at < updated_at`. change_seen_at is written from a
-- client-side `new Date().toISOString()` timestamp computed a few
-- milliseconds before the request reaches the database, while the trigger's
-- updated_at is the server's now() at the moment that same UPDATE actually
-- runs — always slightly later. So the very update meant to clear the
-- banner also re-tripped the condition that shows it, and the banner came
-- right back on the next load.
--
-- Fix: skip the updated_at bump when change_seen_at is the ONLY column that
-- changed (compare the row with change_seen_at normalized out on both
-- sides). Any update that changes a real field still bumps updated_at as
-- before.
create or replace function public.set_reservations_updated_at()
returns trigger
language plpgsql
as $$
declare
  v_new_without_seen public.reservations;
  v_old_without_seen public.reservations;
begin
  v_new_without_seen := new;
  v_old_without_seen := old;
  v_new_without_seen.change_seen_at := null;
  v_old_without_seen.change_seen_at := null;

  if v_new_without_seen is distinct from v_old_without_seen then
    new.updated_at = now();
  end if;

  return new;
end;
$$;
