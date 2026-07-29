alter table public.reservation_status enable row level security;

grant select, insert on public.reservation_status to authenticated;

drop policy if exists "select own reservation status history" on public.reservation_status;
create policy "select own reservation status history"
  on public.reservation_status for select
  using (
    exists (
      select 1
      from public.reservations r
      where r.reservation_id = reservation_status.reservation_id
        and r.user_id = auth.uid()
    )
  );

drop policy if exists "admin read all reservation status history" on public.reservation_status;
create policy "admin read all reservation status history"
  on public.reservation_status for select
  using (
    exists (
      select 1
      from public.profiles p
      where p.user_id = auth.uid()
        and p.role = 'admin'
    )
  );

drop policy if exists "insert own reservation status history" on public.reservation_status;
create policy "insert own reservation status history"
  on public.reservation_status for insert
  with check (
    exists (
      select 1
      from public.reservations r
      where r.reservation_id = reservation_status.reservation_id
        and r.user_id = auth.uid()
    )
  );

drop policy if exists "admin insert reservation status history" on public.reservation_status;
create policy "admin insert reservation status history"
  on public.reservation_status for insert
  with check (
    exists (
      select 1
      from public.profiles p
      where p.user_id = auth.uid()
        and p.role = 'admin'
    )
  );
