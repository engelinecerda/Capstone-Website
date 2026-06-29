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
              r.event_date < timezone('Asia/Manila', now())::date
              or (
                r.event_date = timezone('Asia/Manila', now())::date
                and coalesce(
                  to_timestamp(
                    coalesce(nullif(trim(coalesce(r.event_time, '')), ''), '12:00 AM'),
                    'HH12:MI AM'
                  )::time,
                  time '00:00'
                ) <= timezone('Asia/Manila', now())::time
              )
            )
          )
        )
    )
  );
