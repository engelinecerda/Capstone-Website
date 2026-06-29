-- Allow staff members to read only the reservations they are assigned to.
-- Run this in the Supabase SQL Editor after reservation_staff_assignments exists.

drop policy if exists "assigned staff can read assigned reservations" on public.reservations;

create policy "assigned staff can read assigned reservations"
  on public.reservations for select
  using (
    exists (
      select 1
      from public.profiles p
      join public.reservation_staff_assignments rsa
        on rsa.staff_user_id = p.user_id
      where p.user_id = auth.uid()
        and p.role = 'staff'
        and rsa.reservation_id = reservations.reservation_id
    )
  );
