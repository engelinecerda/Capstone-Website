create table if not exists public.reviews (
  review_id uuid primary key default gen_random_uuid(),
  reservation_id uuid not null references public.reservations(reservation_id) on delete cascade,
  user_id uuid not null references public.profiles(user_id) on delete cascade,
  rating int4 not null check (rating between 1 and 5),
  comment text,
  created_at timestamptz not null default now(),
  unique (reservation_id)
);

create index if not exists reviews_user_id_created_at_idx
  on public.reviews (user_id, created_at desc);

create index if not exists reviews_created_at_idx
  on public.reviews (created_at desc);

alter table public.reservations
  add column if not exists review_prompt_dismissed_at timestamptz;

alter table public.reviews enable row level security;

grant select, insert on public.reviews to authenticated;

drop policy if exists "select own reviews" on public.reviews;
create policy "select own reviews"
  on public.reviews for select
  using (auth.uid() = user_id);

drop policy if exists "insert own completed reservation review" on public.reviews;
create policy "insert own completed reservation review"
  on public.reviews for insert
  with check (
    auth.uid() = user_id
    and exists (
      select 1
      from public.reservations r
      where r.reservation_id = reviews.reservation_id
        and r.user_id = auth.uid()
        and (
          lower(coalesce(r.status, '')) = 'completed'
          or (
            lower(coalesce(r.status, '')) in ('approved', 'confirmed', 'rescheduled')
            and (
              r.event_date < current_date
              or (
                r.event_date = current_date
                and coalesce(
                  to_timestamp(trim(coalesce(r.event_time, '12:00 AM')), 'HH12:MI AM')::time,
                  time '00:00'
                ) <= localtime
              )
            )
          )
        )
    )
  );

drop policy if exists "admin read all reviews" on public.reviews;
create policy "admin read all reviews"
  on public.reviews for select
  using (
    exists (
      select 1
      from public.profiles p
      where p.user_id = auth.uid()
        and p.role = 'admin'
    )
  );

create or replace function public.dismiss_reservation_review_prompt(p_reservation_id uuid)
returns public.reservations
language plpgsql
security definer
set search_path = public
as $$
declare
  updated_row public.reservations;
begin
  update public.reservations
  set review_prompt_dismissed_at = now()
  where reservation_id = p_reservation_id
    and user_id = auth.uid()
    and review_prompt_dismissed_at is null
  returning * into updated_row;

  if updated_row.reservation_id is null then
    select *
    into updated_row
    from public.reservations
    where reservation_id = p_reservation_id
      and user_id = auth.uid();
  end if;

  if updated_row.reservation_id is null then
    raise exception 'Reservation not found or not owned by current user.';
  end if;

  return updated_row;
end;
$$;

grant execute on function public.dismiss_reservation_review_prompt(uuid) to authenticated;
