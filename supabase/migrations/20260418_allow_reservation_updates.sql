grant update on public.reservations to authenticated;

drop policy if exists "update own reservations" on public.reservations;
create policy "update own reservations"
  on public.reservations for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists "admin manage reservations" on public.reservations;
create policy "admin manage reservations"
  on public.reservations for update
  using (
    exists (
      select 1
      from public.profiles p
      where p.user_id = auth.uid()
        and p.role = 'admin'
    )
  )
  with check (
    exists (
      select 1
      from public.profiles p
      where p.user_id = auth.uid()
        and p.role = 'admin'
    )
  );
