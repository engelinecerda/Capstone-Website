-- ============================================================
-- Manager/admin write access to reservation_staff_assignments
--
-- Prior migrations gave staff a read-only policy on this table
-- (20260716_staff_roster_and_board_account.sql: "staff read all
-- assignments") and gave manager/admin a manage policy on staff_roster,
-- but no policy ever granted manager/admin insert/update/delete on
-- reservation_staff_assignments itself. That's what the Assign staff
-- modal writes to (js/admin_reservation_details.js saveAssignmentSelection),
-- so saves fail with an RLS error even though the table exists.
-- ============================================================
alter table public.reservation_staff_assignments enable row level security;

drop policy if exists "manager admin manage assignments" on public.reservation_staff_assignments;
create policy "manager admin manage assignments"
  on public.reservation_staff_assignments for all
  using (get_my_role() in ('manager', 'admin'))
  with check (get_my_role() in ('manager', 'admin'));
