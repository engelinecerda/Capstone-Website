# Supabase SQL Setup

Run these in your Supabase SQL Editor in order.

---

## Step 1 - Create the `profiles` table

```sql
create table if not exists public.profiles (
  user_id         uuid primary key references auth.users(id) on delete cascade,
  first_name      text not null,
  middle_name     text,
  last_name       text not null,
  email           text not null,
  phone_number    text,
  role            text default 'customer',
  date_registered timestamptz default now()
);

alter table public.profiles enable row level security;

create policy "select own profile"
  on public.profiles for select
  using (auth.uid() = user_id);

create policy "insert own profile"
  on public.profiles for insert
  with check (auth.uid() = user_id);

create policy "update own profile"
  on public.profiles for update
  using (auth.uid() = user_id);

create policy "admin read all profiles"
  on public.profiles for select
  using (
    exists (
      select 1
      from public.profiles p
      where p.user_id = auth.uid()
        and p.role = 'admin'
    )
  );
```

---

## Step 2 - Automatically create a profile when a user signs up

```sql
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (
    user_id,
    first_name,
    middle_name,
    last_name,
    email,
    phone_number,
    role,
    date_registered
  )
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'first_name', ''),
    nullif(new.raw_user_meta_data->>'middle_name', ''),
    coalesce(new.raw_user_meta_data->>'last_name', ''),
    new.email,
    nullif(new.raw_user_meta_data->>'phone_number', ''),
    coalesce(new.raw_user_meta_data->>'role', 'customer'),
    now()
  )
  on conflict (user_id) do nothing;

  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();
```

If your admin account already exists, set its role once:

```sql
update public.profiles
set role = 'admin'
where email = 'adminelicoffee@gmail.com';
```

If that update affects `0 rows`, the admin user exists in `auth.users` but does not have a matching `public.profiles` row yet. Repair it with:

```sql
insert into public.profiles (
  user_id,
  first_name,
  last_name,
  email,
  role,
  date_registered
)
select
  id,
  'Admin',
  'User',
  email,
  'admin',
  now()
from auth.users
where email = 'adminelicoffee@gmail.com'
on conflict (user_id) do update
set role = excluded.role,
    email = excluded.email;
```

---

## Step 3 - Create the `package` table

```sql
create table public.package (
  package_id      uuid primary key default gen_random_uuid(),
  package_name    text not null,
  description     text,
  package_type    text not null,
  price           numeric default 0,
  guest_capacity  int,
  extension_price numeric,
  location_type   text,
  is_active       boolean default true,
  created_at      timestamptz default now()
);

alter table public.package enable row level security;

create policy "public read active packages"
  on public.package for select
  using (is_active = true);

create policy "admin read all packages"
  on public.package for select
  using (
    exists (
      select 1
      from public.profiles p
      where p.user_id = auth.uid()
        and p.role = 'admin'
    )
  );
```

---

## Step 4 - Migrate the `reservations` table

If your current `reservations` table has live data you want to keep, use Option A. If it is empty or test data, use Option B.

### Option A - ALTER existing table

```sql
alter table public.reservations rename column time_slot to event_time;

alter table public.reservations
  drop column if exists package_name,
  drop column if exists package_details,
  drop column if exists contract_url;

alter table public.reservations
  add column if not exists package_id uuid references public.package(package_id),
  add column if not exists add_on_id  uuid references public.package(package_id);
```

### Option B - Drop and recreate

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

## Step 5 - RLS policies for `reservations`

```sql
alter table public.reservations enable row level security;

create policy "select own reservations"
  on public.reservations for select
  using (auth.uid() = user_id);

create policy "insert own reservations"
  on public.reservations for insert
  with check (auth.uid() = user_id);

create policy "admin read all reservations"
  on public.reservations for select
  using (
    exists (
      select 1
      from public.profiles p
      where p.user_id = auth.uid()
        and p.role = 'admin'
    )
  );
```

---

## Step 6 - Create the `contracts` table

```sql
create table if not exists public.contracts (
  contract_id   uuid primary key default gen_random_uuid(),
  reservation_id uuid not null references public.reservations(reservation_id) on delete cascade,
  contract_type text not null,
  description   text,
  contract_url  text not null,
  verified_date timestamptz
);

alter table public.contracts enable row level security;

create policy "select own contracts"
  on public.contracts for select
  using (
    exists (
      select 1
      from public.reservations r
      where r.reservation_id = contracts.reservation_id
        and r.user_id = auth.uid()
    )
  );

create policy "insert own contracts"
  on public.contracts for insert
  with check (
    exists (
      select 1
      from public.reservations r
      where r.reservation_id = contracts.reservation_id
        and r.user_id = auth.uid()
    )
  );

create policy "admin read all contracts"
  on public.contracts for select
  using (
    exists (
      select 1
      from public.profiles p
      where p.user_id = auth.uid()
        and p.role = 'admin'
    )
  );
```

---

## Step 7 - Create the `calendar_blackouts` table (for admin date closures)

```sql
create table if not exists public.calendar_blackouts (
  date       date primary key,
  note       text,
  created_by uuid references auth.users(id),
  created_at timestamptz default now()
);

alter table public.calendar_blackouts enable row level security;

create policy "admin manage blackouts"
  on public.calendar_blackouts
  for all
  using (
    exists (
      select 1 from public.profiles p
      where p.user_id = auth.uid()
        and p.role = 'admin'
    )
  )
  with check (
    exists (
      select 1 from public.profiles p
      where p.user_id = auth.uid()
        and p.role = 'admin'
    )
  );

create policy "customers read blackouts"
  on public.calendar_blackouts
  for select
  using (true);
```

If `profiles` was changed from `id` to `user_id` after you already created the blackout policy, recreate that policy so it points at the new column:

```sql
drop policy if exists "admin manage blackouts" on public.calendar_blackouts;

create policy "admin manage blackouts"
  on public.calendar_blackouts
  for all
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
```

If you already created `calendar_blackouts` in the dashboard and the app shows `Could not find the 'date' column of 'calendar_blackouts' in the schema cache`, that is not because the table is empty. It means the live table does not currently expose a column literally named `date` to Supabase's REST API.

Run this repair SQL in the Supabase SQL Editor:

```sql
alter table public.calendar_blackouts
  add column if not exists date date;

create unique index if not exists calendar_blackouts_date_key
  on public.calendar_blackouts (date);

notify pgrst, 'reload schema';
```

If the table was created incorrectly and it is still empty, the cleanest fix is to recreate it:

```sql
drop table if exists public.calendar_blackouts;

create table public.calendar_blackouts (
  date       date primary key,
  note       text,
  created_by uuid references auth.users(id),
  created_at timestamptz default now()
);

alter table public.calendar_blackouts enable row level security;

create policy "admin manage blackouts"
  on public.calendar_blackouts
  for all
  using (
    exists (
      select 1 from public.profiles p
      where p.user_id = auth.uid()
        and p.role = 'admin'
    )
  )
  with check (
    exists (
      select 1 from public.profiles p
      where p.user_id = auth.uid()
        and p.role = 'admin'
    )
  );

create policy "customers read blackouts"
  on public.calendar_blackouts
  for select
  using (true);

notify pgrst, 'reload schema';
```

---

## Step 8 - Create the `reservation_staff_assignments` table

```sql
create table if not exists public.reservation_staff_assignments (
  assignment_id   bigint generated always as identity primary key,
  reservation_id  uuid not null references public.reservations(reservation_id) on delete cascade,
  staff_user_id   uuid not null references public.profiles(user_id) on delete cascade,
  assigned_at     timestamptz not null default now(),
  assigned_by     uuid references public.profiles(user_id),
  unique (reservation_id, staff_user_id)
);

alter table public.reservation_staff_assignments enable row level security;

create policy "admin manage reservation staff assignments"
  on public.reservation_staff_assignments
  for all
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

create policy "assigned staff can read own assignments"
  on public.reservation_staff_assignments
  for select
  using (staff_user_id = auth.uid());

notify pgrst, 'reload schema';
```

Quick test query:

```sql
select *
from public.reservation_staff_assignments
limit 20;
```

---

## Step 9 - Allow staff to read assigned reservations

Run the SQL from `supabase/staff_dashboard_access.sql`, or paste this directly into the SQL Editor:

```sql
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
```

This policy keeps the staff dashboard view-only and limits each staff account to reservations that were explicitly assigned to that same staff user.

---

## Step 10 - Enable reservation reviews

Run these review migrations in order:

1. `supabase/migrations/20260411_create_reviews.sql`
2. `supabase/migrations/20260413_fix_review_policy_timezone.sql`

The second migration keeps review eligibility aligned with the frontend by checking past event times in `Asia/Manila` instead of the database server timezone.

---

### Step-by-step in Supabase Dashboard

1. Open your Supabase project.
2. In the left sidebar, click `SQL Editor`.
3. Click `New query`.
4. Copy the full SQL block from `Step 7 - Create the calendar_blackouts table`.
5. Click `Run`.
6. Wait for the success message at the bottom of the SQL Editor.
7. In the left sidebar, open `Table Editor`.
8. Confirm that a new table named `calendar_blackouts` now exists and includes a `date` column.
9. Open the `calendar_blackouts` table and check that these columns were created:
   `date`, `note`, `created_by`, `created_at`
10. Open `Authentication` or `Database` policy view if needed and confirm RLS is enabled for `calendar_blackouts`.

### What each column is for

- `date`: the specific calendar date the admin wants to close
- `note`: optional reason for the closure
- `created_by`: the admin user who created the blackout
- `created_at`: when the blackout was added

### How your app will store uploaded contracts

1. The user picks a package.
2. The user downloads that package's contract PDF.
3. The user signs it and uploads it in the reservation form.
4. Your code uploads the signed file to Cloudinary.
5. Cloudinary returns a `secure_url`.
6. Your code inserts the reservation into `public.reservations`.
7. After that succeeds, your code inserts one row into `public.contracts` using:
   `reservation_id` from the reservation row and `contract_url` from Cloudinary.

### Quick test query

After submitting one reservation with an uploaded contract, run this in `SQL Editor`:

```sql
select
  c.contract_id,
  c.reservation_id,
  c.contract_type,
  c.description,
  c.contract_url,
  c.verified_date,
  r.user_id,
  r.event_type,
  r.created_at
from public.contracts c
join public.reservations r
  on r.reservation_id = c.reservation_id
order by r.created_at desc;
```

If everything is working, you should see one `contracts` row connected to the reservation the user just submitted.

---

## Step 7 - Populate `package` table with your packages

```sql
insert into public.package (package_name, package_type, price, guest_capacity, location_type, description) values
  ('VIP Lite',        'main', 2999,  18, 'onsite', '15-18 pax, 2 hours, P2,000 food credit'),
  ('VIP Plus',        'main', 3999,  18, 'onsite', '15-18 pax, 3 hours, P2,499 food credit'),
  ('VIP Max',         'main', 4999,  18, 'onsite', '15-18 pax, 4 hours, P3,000 food credit'),
  ('Main Hall Basic', 'main', 9999,  25, 'onsite', 'Up to 25 pax, 2 hours, P8,000 food credit'),
  ('Main Hall Plus',  'main', 11999, 25, 'onsite', 'Up to 25 pax, 3 hours, P9,000 food credit');

insert into public.package (package_name, package_type, price, location_type, description) values
  ('Biscuits & Candies',         'add on', 3500, 'onsite', 'Chocolate fountain, biscuits, candies, marshmallow, brownies, 20 donuts'),
  ('Biscuits, Candies & Fruits', 'add on', 4000, 'onsite', 'Chocolate fountain, biscuits, candies, marshmallow, 4 seasonal fruits'),
  ('Biscuits, Chips & Drinks',   'add on', 5000, 'onsite', 'Chocolate fountain, biscuits, chips, cupcakes, marshmallow, 2 drinks');

insert into public.package (package_name, package_type, price, guest_capacity, location_type, description) values
  ('Eli Coffee Bar 30 pax',  'main', 3990,  30,  'offsite', '2-3 baristas, 3 hours service, 1:1 coffee serving'),
  ('Eli Coffee Bar 50 pax',  'main', 5990,  50,  'offsite', '2-3 baristas, 3 hours service, 1:1 coffee serving'),
  ('Eli Coffee Bar 100 pax', 'main', 10990, 100, 'offsite', '2-3 baristas, 3 hours service, 1:1 coffee serving'),
  ('Eli Coffee Bar 150 pax', 'main', 14990, 150, 'offsite', '2-3 baristas, 3 hours service, 1:1 coffee serving');

insert into public.package (package_name, package_type, price, location_type, description) values
  ('Snack Bar Biscuits & Candies',         'main', 3500, 'offsite', 'Chocolate fountain, biscuits, candies, marshmallow, brownies, 20 donuts'),
  ('Snack Bar Biscuits, Candies & Fruits', 'main', 4000, 'offsite', 'Chocolate fountain, biscuits, candies, marshmallow, 4 seasonal fruits'),
  ('Snack Bar Biscuits, Chips & Drinks',   'main', 5000, 'offsite', 'Chocolate fountain, biscuits, chips, cupcakes, marshmallow, 2 drinks'),
  ('Catering Package',                     'main', 0,    'offsite', 'Buffet setup, utensils, waiters, styled tables, backdrop, centerpiece, 3-4 hrs service');
```

---

## Hosted Supabase settings

Because this project uses a hosted Supabase project, also update these in the Supabase Dashboard:

1. `Authentication -> Providers -> Email -> Confirm email`: turn this on.
2. `Authentication -> URL Configuration -> Site URL`: set this to the base URL where your app runs.
3. `Authentication -> URL Configuration -> Redirect URLs`: add the exact URL for your login page, such as `http://127.0.0.1:5500/pages/login_signup.html` or your deployed URL.

The frontend signup now sends `first_name`, `middle_name`, `last_name`, `phone_number`, and `role` in `signUp(...options.data...)`. The trigger above copies that metadata into `public.profiles`.
