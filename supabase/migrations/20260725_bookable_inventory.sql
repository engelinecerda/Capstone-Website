-- Bookable inventory: venues (genuinely new) + multi-photo, structured
-- inclusions, and a guest min/max range added onto the EXISTING package /
-- package_category tables (not a parallel product/product_category schema
-- — see the "Bookable Inventory" plan for why: a fresh product table would
-- itself be the parallel-tables problem the spec's own first principle
-- warns against).
--
-- package_tier (Bronze/Silver/Gold inclusion variants) is untouched —
-- orthogonal existing feature, not part of this work.

-- Venues: physically at the café, no location field of their own.
create table if not exists public.venue (
  venue_id    uuid primary key default gen_random_uuid(),
  name        text not null,
  description text,
  capacity    int not null check (capacity > 0),
  is_active   boolean not null default true,
  sort_order  int not null default 0,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create table if not exists public.package_venue (
  package_id uuid not null references public.package(package_id) on delete cascade,
  venue_id   uuid not null references public.venue(venue_id)   on delete restrict,
  primary key (package_id, venue_id)
);

create table if not exists public.package_photo (
  photo_id   uuid primary key default gen_random_uuid(),
  package_id uuid not null references public.package(package_id) on delete cascade,
  image_url  text not null,
  alt_text   text,
  is_cover   boolean not null default false,
  sort_order int not null default 0,
  created_at timestamptz not null default now()
);

create unique index if not exists one_cover_per_package
  on public.package_photo (package_id) where is_cover;

-- Backfill: every package's existing single package_image becomes its
-- cover photo, so nothing loses its picture the moment this ships.
insert into public.package_photo (package_id, image_url, is_cover, sort_order)
select package_id, package_image, true, 0
from public.package
where package_image is not null
  and not exists (select 1 from public.package_photo pp where pp.package_id = package.package_id);

-- guest_capacity is untouched (too much existing code reads it — customer
-- catalogue, the capacity-conflict trigger); min_guests/max_guests are
-- added alongside it as the new source of truth for the admin form and
-- venue-capacity validation. The app keeps guest_capacity in sync with
-- max_guests on every save going forward.
alter table public.package
  add column if not exists min_guests   int check (min_guests >= 0),
  add column if not exists max_guests   int check (max_guests >= 0),
  add column if not exists max_quantity int not null default 1 check (max_quantity >= 1),
  add column if not exists inclusions   jsonb not null default '[]'::jsonb;

alter table public.package
  drop constraint if exists package_guest_range,
  add constraint package_guest_range check (min_guests is null or max_guests is null or min_guests <= max_guests);

alter table public.venue enable row level security;

create policy "Public read active venues" on public.venue for select using (is_active = true);

create policy "Admin read all venues" on public.venue for select using (
  exists (select 1 from public.profiles p where p.user_id = auth.uid() and p.role in ('admin','manager','staff'))
);

create policy "Admin manage venues" on public.venue for all
  using (get_my_role() = 'admin') with check (get_my_role() = 'admin');

alter table public.package_venue enable row level security;

create policy "Public read package_venue" on public.package_venue for select using (true);

create policy "Admin manage package_venue" on public.package_venue for all
  using (get_my_role() = 'admin') with check (get_my_role() = 'admin');

alter table public.package_photo enable row level security;

create policy "Public read package_photo" on public.package_photo for select using (true);

create policy "Admin manage package_photo" on public.package_photo for all
  using (get_my_role() = 'admin') with check (get_my_role() = 'admin');

create or replace function public.set_venue_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists trg_venue_updated_at on public.venue;
create trigger trg_venue_updated_at
  before update on public.venue
  for each row
  execute function public.set_venue_updated_at();
