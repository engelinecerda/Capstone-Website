-- Fix: Manager cannot close/reopen dates on the Availability Calendar.
--
-- calendar_blackouts was hand-rolled in the SQL Editor (no CREATE TABLE ever
-- shipped in supabase/migrations/) per the documented setup in
-- supabase_setup.md, whose write policy checks profiles.role = 'admin' — the
-- PRE-RENAME role value. After 20260624_rename_roles_admin_to_manager.sql,
-- 'admin' means the read-only system-owner tier and the operational role
-- (the one that should own blackout dates — see the Availability &
-- Scheduling admin/manager split) is 'manager'. That rename migration never
-- touched this table because it isn't tracked in migrations at all, so the
-- live policy was likely never fixed — blocking the Manager from writing
-- blackout rows through js/admin_availability_calendar.js's upsert/delete
-- calls (RLS silently rejects the write with no useful client-side error).
--
-- This does not touch table structure/columns (still unknown/unverified from
-- the repo) — only the role check in the write policy, which is safe
-- regardless of the live table's actual column names.
-- ─────────────────────────────────────────────────────────────────────────────

alter table public.calendar_blackouts enable row level security;

-- Drop every plausible existing policy name defensively — DROP POLICY IF
-- EXISTS is a no-op when the name doesn't match, so guessing wrong costs
-- nothing.
drop policy if exists "admin manage blackouts" on public.calendar_blackouts;
drop policy if exists "Admin manage blackouts" on public.calendar_blackouts;
drop policy if exists "manager manage blackouts" on public.calendar_blackouts;
drop policy if exists "Manager manage blackouts" on public.calendar_blackouts;
drop policy if exists "customers read blackouts" on public.calendar_blackouts;
drop policy if exists "Customers read blackouts" on public.calendar_blackouts;
drop policy if exists "Public read blackouts" on public.calendar_blackouts;

-- Blackout dates are the Manager's, per the Availability & Scheduling
-- role split — Admin gets no write access here (they don't perform
-- operational tasks), matching get_my_role()'s standard convention used
-- everywhere else in this project.
create policy "Manager manage blackouts" on public.calendar_blackouts
  for all
  using (get_my_role() = 'manager')
  with check (get_my_role() = 'manager');

-- Public read stays wide — the customer calendar greys out blackout dates
-- client-side (js/reservation_availability.js), which requires anon/
-- authenticated SELECT access.
create policy "Public read blackouts" on public.calendar_blackouts
  for select using (true);

grant select on public.calendar_blackouts to anon;
