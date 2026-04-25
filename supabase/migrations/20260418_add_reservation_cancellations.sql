create table if not exists public.reservation_cancellations (
  cancellation_id uuid primary key default gen_random_uuid(),
  reservation_id uuid not null unique references public.reservations(reservation_id) on delete cascade,
  user_id uuid not null references public.profiles(user_id) on delete cascade,
  previous_status text,
  reason text,
  cancelled_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create index if not exists reservation_cancellations_user_id_idx
  on public.reservation_cancellations (user_id, cancelled_at desc);

create index if not exists reservation_cancellations_cancelled_at_idx
  on public.reservation_cancellations (cancelled_at desc);

alter table public.reservation_cancellations enable row level security;

grant select on public.reservation_cancellations to authenticated;

drop policy if exists "select own reservation cancellations" on public.reservation_cancellations;
create policy "select own reservation cancellations"
  on public.reservation_cancellations for select
  using (auth.uid() = user_id);

drop policy if exists "admin read all reservation cancellations" on public.reservation_cancellations;
create policy "admin read all reservation cancellations"
  on public.reservation_cancellations for select
  using (
    exists (
      select 1
      from public.profiles p
      where p.user_id = auth.uid()
        and p.role = 'admin'
    )
  );

create or replace function public.cancel_own_reservation(
  p_reservation_id uuid,
  p_reason text default null
)
returns public.reservations
language plpgsql
security definer
set search_path = public
as $$
declare
  v_reservation public.reservations%rowtype;
  v_reason text := nullif(trim(coalesce(p_reason, '')), '');
begin
  select *
  into v_reservation
  from public.reservations
  where reservation_id = p_reservation_id
    and user_id = auth.uid()
  for update;

  if v_reservation.reservation_id is null then
    raise exception 'Reservation not found or not owned by current user.';
  end if;

  if lower(coalesce(v_reservation.status, 'pending')) in ('cancelled', 'completed', 'declined') then
    raise exception 'This reservation can no longer be cancelled.';
  end if;

  update public.reservations
  set status = 'cancelled'
  where reservation_id = v_reservation.reservation_id;

  insert into public.reservation_cancellations (
    reservation_id,
    user_id,
    previous_status,
    reason,
    cancelled_at
  )
  values (
    v_reservation.reservation_id,
    v_reservation.user_id,
    v_reservation.status,
    v_reason,
    now()
  )
  on conflict (reservation_id) do update
  set previous_status = excluded.previous_status,
      reason = excluded.reason,
      cancelled_at = excluded.cancelled_at;

  insert into public.reservation_status (
    reservation_id,
    previous_status,
    new_status,
    changed_at
  )
  values (
    v_reservation.reservation_id,
    v_reservation.status,
    'cancelled',
    now()
  );

  select *
  into v_reservation
  from public.reservations
  where reservation_id = p_reservation_id;

  return v_reservation;
end;
$$;

grant execute on function public.cancel_own_reservation(uuid, text) to authenticated;
