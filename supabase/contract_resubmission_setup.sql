alter table public.reservation_contracts
  add column if not exists review_status text,
  add column if not exists review_notes text,
  add column if not exists reviewed_at timestamptz,
  add column if not exists resubmitted_at timestamptz;

update public.reservation_contracts
set review_status = case
  when verified_date is not null then 'verified'
  when contract_url is not null then 'pending_review'
  else null
end
where review_status is null;

alter table public.reservation_contracts
  alter column review_status set default 'pending_review';

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'reservation_contracts_review_status_check'
  ) then
    alter table public.reservation_contracts
      add constraint reservation_contracts_review_status_check
      check (review_status in ('pending_review', 'resubmission_requested', 'verified'));
  end if;
end $$;

alter table public.reservation_contracts enable row level security;

drop policy if exists "admin update reservation contracts" on public.reservation_contracts;
create policy "admin update reservation contracts"
on public.reservation_contracts
for update
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

drop policy if exists "customer update own reservation contracts" on public.reservation_contracts;
create policy "customer update own reservation contracts"
on public.reservation_contracts
for update
using (
  exists (
    select 1
    from public.reservations r
    where r.reservation_id = reservation_contracts.reservation_id
      and r.user_id = auth.uid()
  )
)
with check (
  exists (
    select 1
    from public.reservations r
    where r.reservation_id = reservation_contracts.reservation_id
      and r.user_id = auth.uid()
  )
);
