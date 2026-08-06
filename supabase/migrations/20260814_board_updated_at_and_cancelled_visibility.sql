-- Operations Board redesign: track when an approved reservation was last
-- modified (for the "Updated" badge), and let a same-day cancellation stay
-- visible on the board for the rest of that day instead of vanishing.

-- ============================================================
-- 1. reservations.updated_at + BEFORE UPDATE trigger
-- ============================================================
alter table public.reservations
  add column if not exists updated_at timestamptz not null default now();

update public.reservations
set updated_at = created_at
where updated_at is null;

create or replace function public.set_reservations_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_reservations_set_updated_at on public.reservations;
create trigger trg_reservations_set_updated_at
  before update on public.reservations
  for each row
  execute function public.set_reservations_updated_at();

-- ============================================================
-- 2. board_reservations_view -- additive column only
-- ============================================================
create or replace view public.board_reservations_view
with (security_invoker = true) as
select
  reservation_id,
  event_type,
  event_date,
  event_time,
  event_end_time,
  start_time,
  duration_hours,
  guest_count,
  location_type,
  venue_location,
  status,
  package_id,
  booking_scope,
  reservation_number,
  updated_at
from public.reservations;

grant select on public.board_reservations_view to authenticated;

-- ============================================================
-- 3. Staff RLS -- allow same-day cancelled visibility only
-- ============================================================
drop policy if exists "staff read display-eligible reservations" on public.reservations;
create policy "staff read display-eligible reservations"
  on public.reservations for select
  using (
    get_my_role() = 'staff'
    and (
      status in ('approved', 'confirmed', 'partially_paid', 'fully_paid', 'rescheduled', 'completed')
      or (status = 'cancelled' and event_date = current_date)
    )
  );
