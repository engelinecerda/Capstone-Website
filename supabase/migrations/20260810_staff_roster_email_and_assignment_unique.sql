-- Staff roster management page — schema support.
--
-- staff_roster already exists (20260716_staff_roster_and_board_account.sql)
-- with first_name/last_name/staff_role/is_active — this only adds the one
-- missing field (email, a contact detail, never a login/identity key).
--
-- Also closes a real data-integrity gap: reservation_staff_assignments'
-- original uniqueness was UNIQUE(reservation_id, staff_user_id). That
-- column was made nullable in 20260723_relax_staff_assignment_user_id.sql,
-- and Postgres treats NULLs as distinct in unique constraints — so once
-- every new row has staff_user_id = NULL, that constraint stopped
-- preventing duplicate (reservation_id, roster_staff_id) rows at the
-- database level. Duplicate-assignment protection has been client-side
-- only since then (the Assign staff modal's diff logic). This adds the
-- real constraint.

alter table public.staff_roster
  add column if not exists email text;

alter table public.staff_roster
  drop constraint if exists staff_roster_email_format_check;
alter table public.staff_roster
  add constraint staff_roster_email_format_check
    check (email is null or email ~* '^[^@]+@[^@]+\.[^@]+$');

-- Defensive: the constraint below can only be added if no duplicate
-- (reservation_id, roster_staff_id) pairs already exist. Since that's been
-- unenforced since staff_user_id went nullable, there may be some — keep
-- the earliest assignment per pair and drop the rest before adding it.
delete from public.reservation_staff_assignments a
using public.reservation_staff_assignments b
where a.reservation_id = b.reservation_id
  and a.roster_staff_id = b.roster_staff_id
  and a.roster_staff_id is not null
  and a.assignment_id > b.assignment_id;

alter table public.reservation_staff_assignments
  drop constraint if exists reservation_staff_assignments_reservation_roster_unique;
alter table public.reservation_staff_assignments
  add constraint reservation_staff_assignments_reservation_roster_unique
    unique (reservation_id, roster_staff_id);
