-- Operations Board: replace individual staff logins with a single shared
-- read-only "board" kiosk account. Staff become a roster of assignable names
-- with no auth attached; the board account is the only profiles row with
-- role = 'staff' going forward.
--
-- This migration is purely additive/safe. It does NOT delete any existing
-- staff auth account or drop any existing column. See the bottom of this
-- file for the manual, later, operator-only destructive step.

-- ============================================================
-- 1. staff_roster — staff identity decoupled from auth entirely
-- ============================================================
create table if not exists public.staff_roster (
  staff_id       bigint generated always as identity primary key,
  first_name     text not null,
  last_name      text,
  staff_role     text,
  is_active      boolean not null default true,
  created_at     timestamptz not null default now(),
  -- Provenance only, used for the one-time backfill join below. Deliberately
  -- not a foreign key to profiles/auth.users -- those rows are slated for
  -- manual deletion in a later step and this column must not block that.
  source_user_id uuid
);

create unique index if not exists staff_roster_source_user_id_key
  on public.staff_roster (source_user_id)
  where source_user_id is not null;

alter table public.staff_roster enable row level security;

-- ============================================================
-- 2. Backfill staff_roster from existing profiles rows
-- ============================================================
insert into public.staff_roster (first_name, last_name, staff_role, is_active, source_user_id)
select p.first_name, coalesce(p.last_name, ''), p.staff_role, not coalesce(p.is_locked, false), p.user_id
from public.profiles p
where p.role = 'staff'
on conflict (source_user_id) where source_user_id is not null do nothing;

-- ============================================================
-- 3. reservation_staff_assignments.roster_staff_id
-- ============================================================
alter table public.reservation_staff_assignments
  add column if not exists roster_staff_id bigint references public.staff_roster(staff_id);

update public.reservation_staff_assignments rsa
set roster_staff_id = sr.staff_id
from public.staff_roster sr
where sr.source_user_id = rsa.staff_user_id
  and rsa.roster_staff_id is null;

-- ============================================================
-- 4. profiles.is_board_account flag
-- ============================================================
alter table public.profiles add column if not exists is_board_account boolean not null default false;

-- ============================================================
-- 5. RLS -- replace narrow per-user staff policies with role-based ones
-- ============================================================
drop policy if exists "assigned staff can read own assignments" on public.reservation_staff_assignments;
create policy "staff read all assignments"
  on public.reservation_staff_assignments for select
  using (get_my_role() = 'staff');

drop policy if exists "staff read active roster" on public.staff_roster;
create policy "staff read active roster"
  on public.staff_roster for select
  using (get_my_role() = 'staff' and is_active = true);

drop policy if exists "manager admin manage roster" on public.staff_roster;
create policy "manager admin manage roster"
  on public.staff_roster for all
  using (get_my_role() in ('manager', 'admin'))
  with check (get_my_role() in ('manager', 'admin'));

drop policy if exists "manager admin read roster" on public.staff_roster;
create policy "manager admin read roster"
  on public.staff_roster for select
  using (get_my_role() in ('manager', 'admin'));

drop policy if exists "assigned staff can read assigned reservations" on public.reservations;
create policy "staff read display-eligible reservations"
  on public.reservations for select
  using (
    get_my_role() = 'staff'
    and status in ('approved', 'confirmed', 'partially_paid', 'fully_paid', 'rescheduled', 'completed')
  );

-- ============================================================
-- 6. Privacy-safe view for the board's reservation reads
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
  reservation_number
from public.reservations;
-- Deliberately excludes: user_id, contact_name, contact_email, contact_phone,
-- total_price, pricing_breakdown, special_requests, admin_notes, created_at,
-- legacy_reservation_number -- no customer-identifying or payment data.

grant select on public.board_reservations_view to authenticated;

-- ============================================================
-- 7. Board-account lookup for the forgot-password guard
-- ============================================================
create or replace function public.is_board_account_email(p_email text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.profiles
    where email = p_email and is_board_account = true
  )
$$;

grant execute on function public.is_board_account_email(text) to anon, authenticated;

-- ============================================================
-- 8. Retire the assignment-acknowledgment feature (page removed;
--    leave columns/triggers in place, just close off the RPC).
--    Guarded because 20260715_staff_assignment_acknowledgment.sql may
--    never have been applied to this database.
-- ============================================================
do $$
begin
  if exists (
    select 1 from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'acknowledge_staff_assignment'
  ) then
    revoke execute on function public.acknowledge_staff_assignment(bigint) from authenticated;
  end if;
end $$;

-- ============================================================
-- MANUAL BOOTSTRAP STEP (run after this migration, not part of it):
--
-- 1. Supabase Dashboard -> Authentication -> Add user
--    Email: staffelicoffee@gmail.com
--    Set a password directly. The existing handle_new_user() trigger fires
--    automatically and creates a matching profiles row.
--
-- 2. Then run:
--    update public.profiles
--    set role = 'staff', is_locked = false, is_board_account = true
--    where user_id = (select id from auth.users where email = 'staffelicoffee@gmail.com');
-- ============================================================

-- ============================================================
-- MANUAL SANITY CHECK (run after backfill, before ever touching the
-- destructive step below):
--
--   select count(*) filter (where roster_staff_id is null) as unmapped,
--          count(*) as total
--   from public.reservation_staff_assignments;
--
--   `unmapped` must be 0.
-- ============================================================

-- ============================================================
-- THE ONE DELIBERATE DESTRUCTIVE STEP -- DO NOT RUN AUTOMATICALLY.
-- Only after Phases 2-3 are deployed and verified working end-to-end:
--
-- 1. Re-run the sanity check above -- confirm unmapped = 0.
-- 2. alter table public.reservation_staff_assignments drop column if exists staff_user_id;
-- 3. Only after step 2 succeeds: in the Supabase Dashboard, delete each
--    individual staff auth user ONE AT A TIME (never the board account).
--    This is the point of no return.
-- ============================================================
