# Supabase SQL Setup

Run these in your **Supabase → SQL Editor** in order.

---

## Step 1 — Create the `package` table

```sql
create table public.package (
  package_id      uuid primary key default gen_random_uuid(),
  package_name    text not null,
  description     text,
  package_type    text not null,       -- 'main' or 'add on'
  price           numeric default 0,
  guest_capacity  int,
  extension_price numeric,
  location_type   text,               -- 'onsite' or 'offsite'
  is_active       boolean default true,
  created_at      timestamptz default now()
);

-- RLS: anyone can read active packages (needed for reservation form)
alter table public.package enable row level security;

create policy "public read active packages"
  on public.package for select
  using (is_active = true);
```

---

## Step 2 — Migrate the `reservations` table

> [!CAUTION]
> If your current `reservations` table has **live data you want to keep**, use the ALTER approach (Option A). If it's empty/test data, use Option B to drop and recreate cleanly.

### Option A — ALTER existing table (keeps existing rows)

```sql
-- Rename old columns
alter table public.reservations rename column time_slot to event_time;

-- Drop columns that no longer exist in the schema
alter table public.reservations
  drop column if exists package_name,
  drop column if exists package_details,
  drop column if exists contract_url;

-- Add new FK columns
alter table public.reservations
  add column if not exists package_id uuid references public.package(package_id),
  add column if not exists add_on_id  uuid references public.package(package_id);

-- Rename reservation PK column if needed (check your current name)
-- alter table public.reservations rename column id to reservation_id;
```

### Option B — Drop and recreate (clean start)

```sql
drop table if exists public.reservations cascade;

create table public.reservations (
  reservation_id   uuid primary key default gen_random_uuid(),
  user_id          uuid references auth.users(id) on delete cascade not null,
  event_type       text,
  event_date       date,
  event_time       text,
  guest_count      int,
  location_type    text,
  venue_location   text,
  package_id       uuid references public.package(package_id),
  add_on_id        uuid references public.package(package_id),
  total_price      numeric,
  contact_name     text,
  contact_email    text,
  contact_phone    text,
  special_requests text,
  status           text default 'pending',
  created_at       timestamptz default now()
);
```

---

## Step 3 — RLS policies for `reservations`

```sql
alter table public.reservations enable row level security;

create policy "select own reservations"
  on public.reservations for select
  using (auth.uid() = user_id);

create policy "insert own reservations"
  on public.reservations for insert
  with check (auth.uid() = user_id);
```

---

## Step 4 — Populate `package` table with your packages

Paste your actual packages below. Adjust names and prices to match your business.

```sql
-- ONSITE MAIN PACKAGES
insert into public.package (package_name, package_type, price, guest_capacity, location_type, description) values
  ('VIP Lite',        'main', 2999,  18, 'onsite', '15–18 pax • 2 hours • ₱2,000 food credit'),
  ('VIP Plus',        'main', 3999,  18, 'onsite', '15–18 pax • 3 hours • ₱2,499 food credit'),
  ('VIP Max',         'main', 4999,  18, 'onsite', '15–18 pax • 4 hours • ₱3,000 food credit'),
  ('Main Hall Basic', 'main', 9999,  25, 'onsite', 'Up to 25 pax • 2 hours • ₱8,000 food credit'),
  ('Main Hall Plus',  'main', 11999, 25, 'onsite', 'Up to 25 pax • 3 hours • ₱9,000 food credit');

-- ONSITE ADD-ONS (Snack Bar)
insert into public.package (package_name, package_type, price, location_type, description) values
  ('Biscuits & Candies',         'add on', 3500, 'onsite', 'Chocolate fountain, biscuits, candies, marshmallow, brownies, 20 donuts'),
  ('Biscuits, Candies & Fruits', 'add on', 4000, 'onsite', 'Chocolate fountain, biscuits, candies, marshmallow, 4 seasonal fruits'),
  ('Biscuits, Chips & Drinks',   'add on', 5000, 'onsite', 'Chocolate fountain, biscuits, chips, cupcakes, marshmallow, 2 drinks');

-- OFFSITE PACKAGES — Coffee Bar
insert into public.package (package_name, package_type, price, guest_capacity, location_type, description) values
  ('Eli Coffee Bar 30 pax',  'main', 3990,  30,  'offsite', '2–3 baristas • 3 hours service • 1:1 coffee serving'),
  ('Eli Coffee Bar 50 pax',  'main', 5990,  50,  'offsite', '2–3 baristas • 3 hours service • 1:1 coffee serving'),
  ('Eli Coffee Bar 100 pax', 'main', 10990, 100, 'offsite', '2–3 baristas • 3 hours service • 1:1 coffee serving'),
  ('Eli Coffee Bar 150 pax', 'main', 14990, 150, 'offsite', '2–3 baristas • 3 hours service • 1:1 coffee serving');

-- OFFSITE PACKAGES — Snack Bar
insert into public.package (package_name, package_type, price, location_type, description) values
  ('Snack Bar Biscuits & Candies',         'main', 3500, 'offsite', 'Chocolate fountain, biscuits, candies, marshmallow, brownies, 20 donuts'),
  ('Snack Bar Biscuits, Candies & Fruits', 'main', 4000, 'offsite', 'Chocolate fountain, biscuits, candies, marshmallow, 4 seasonal fruits'),
  ('Snack Bar Biscuits, Chips & Drinks',   'main', 5000, 'offsite', 'Chocolate fountain, biscuits, chips, cupcakes, marshmallow, 2 drinks');

-- OFFSITE PACKAGES — Catering
insert into public.package (package_name, package_type, price, location_type, description) values
  ('Catering Package', 'main', 0, 'offsite', 'Buffet setup, utensils, waiters, styled tables, backdrop, centerpiece, 3–4 hrs service');
```
