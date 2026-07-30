-- Maintenance Mode (Maintenance module, Part C) — a manual switch that takes
-- the customer surface offline while staff keep full access. Enforcement is
-- split across two independent layers, neither of which can be bypassed by
-- the other's failure:
--   1. middleware.js (Vercel Edge Middleware) gates customer HTML routes,
--      returning a 503 maintenance page instead of the real one.
--   2. The triggers below block the actual data writes (new reservations,
--      new payments) server-side, so a determined user hitting the API
--      directly (bypassing the UI entirely) is still refused.
-- is_on is the ONLY field either layer reads. scheduled_start/scheduled_end
-- exist for a future auto-flip-by-time feature and are NOT evaluated
-- anywhere in this build — do not wire them up without also building the
-- scheduler this project doesn't have yet (same constraint that deferred
-- notification reminders).

create table if not exists public.maintenance_mode (
  id              boolean primary key default true,
  is_on           boolean not null default false,
  title           text not null default 'We''ll be right back',
  message         text not null default 'The site is briefly down for scheduled maintenance. Please check back soon.',
  scheduled_start timestamptz,
  scheduled_end   timestamptz,
  turned_on_at    timestamptz,
  turned_on_by    uuid references auth.users(id),
  updated_at      timestamptz not null default now(),
  constraint singleton check (id)
);

insert into public.maintenance_mode (id) values (true) on conflict (id) do nothing;

create or replace function public.set_maintenance_mode_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_maintenance_mode_set_updated_at on public.maintenance_mode;
create trigger trg_maintenance_mode_set_updated_at
  before update on public.maintenance_mode
  for each row
  execute function public.set_maintenance_mode_updated_at();

alter table public.maintenance_mode enable row level security;

drop policy if exists "Public read maintenance mode" on public.maintenance_mode;
create policy "Public read maintenance mode" on public.maintenance_mode
  for select using (true);

drop policy if exists "Admin manage maintenance mode" on public.maintenance_mode;
create policy "Admin manage maintenance mode" on public.maintenance_mode
  for all using (get_my_role() = 'admin') with check (get_my_role() = 'admin');

-- Café identity for the maintenance page — business_contact had no name/logo
-- field at all (confirmed by a full migration search); seeded with the
-- values already hardcoded everywhere else so nothing changes until an
-- admin edits it. Used only by the maintenance page in this build, not
-- rewired into any other page's existing hardcoded header/footer.
alter table public.business_contact
  add column if not exists brand_name text not null default 'ELI Coffee Events',
  add column if not exists logo_url   text not null default '/images/logo.png';

-- Booking-block trigger — blocks NEW reservations and NEW payments only
-- (INSERT), while maintenance is on, for anyone who isn't staff. Existing
-- customer UPDATE policies on reservations (cancellation/reschedule) are
-- deliberately left untouched — letting a customer cancel their own
-- reservation during maintenance isn't starting new customer-facing load.
-- This does NOT touch or replace the existing (untracked-in-migrations)
-- customer INSERT policies on these tables — it's a separate, additive
-- BEFORE INSERT trigger that fires before RLS is even evaluated, so it
-- can't conflict with whatever policy already allows those inserts.
create or replace function public.block_customer_writes_during_maintenance()
returns trigger
language plpgsql
as $$
begin
  -- Service-role callers (edge functions) have no auth.uid() — bypass.
  -- Cheap insurance: confirmed no current edge function inserts into
  -- reservations/payment, but this avoids a future one being silently
  -- blocked by surprise.
  if current_setting('request.jwt.claims', true)::json->>'role' = 'service_role' then
    return new;
  end if;

  if public.get_my_role() in ('admin', 'manager', 'staff') then
    return new;
  end if;

  if exists (select 1 from public.maintenance_mode where id and is_on) then
    raise exception 'The site is briefly down for maintenance — your details are safe, please return shortly.';
  end if;

  return new;
end;
$$;

drop trigger if exists trg_block_reservations_during_maintenance on public.reservations;
create trigger trg_block_reservations_during_maintenance
  before insert on public.reservations
  for each row
  execute function public.block_customer_writes_during_maintenance();

drop trigger if exists trg_block_payment_during_maintenance on public.payment;
create trigger trg_block_payment_during_maintenance
  before insert on public.payment
  for each row
  execute function public.block_customer_writes_during_maintenance();
