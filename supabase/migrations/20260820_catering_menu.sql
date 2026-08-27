-- Catering menu (foods & drinks) — makes the buffet builder on reservations.html
-- admin-editable instead of the hardcoded DISHES/PRICES JS objects.
--
-- catering_dish_category = a selectable group in the builder (Chicken, Pasta,
--   Dessert, Rice, Drinks...). tag drives the "1 main, 1 pasta, 1 dessert
--   required" validation on the customer form (isCateringSelectionValid()).
--   Pricing is per-category, at the four fixed pax brackets the builder's UI
--   already offers (20/30/40/50) — kept as columns rather than a child table
--   since the brackets are a fixed set, not admin-defined.
-- catering_dish           = the selectable items inside a category.
--
-- Global menu (not per-package) — see chat discussion: there is currently
-- only one catering package, and the "1 main/1 pasta/1 dessert" rule is a
-- menu-structure rule, not a package rule. If a second catering package
-- ever needs its own menu, add a nullable package_id here later.

create table if not exists public.catering_dish_category (
  category_id uuid primary key default gen_random_uuid(),
  name        text not null,
  icon        text not null default '&#127860;',  -- HTML entity, matches DISHES[].icon usage
  tag         text not null check (tag in ('main','pasta','dessert','rice','drinks','addon')),
  is_required boolean not null default true,       -- must the customer pick one of this tag to check out?
  sort_order  int not null default 0,
  is_active   boolean not null default true,
  price_20    numeric not null default 0 check (price_20 >= 0),
  price_30    numeric not null default 0 check (price_30 >= 0),
  price_40    numeric not null default 0 check (price_40 >= 0),
  price_50    numeric not null default 0 check (price_50 >= 0),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create table if not exists public.catering_dish (
  dish_id     uuid primary key default gen_random_uuid(),
  category_id uuid not null references public.catering_dish_category(category_id) on delete cascade,
  name        text not null,
  sort_order  int not null default 0,
  is_active   boolean not null default true,
  created_at  timestamptz not null default now()
);

create index if not exists idx_catering_dish_category on public.catering_dish(category_id);

-- Seed with the current hardcoded menu so nothing breaks on cutover.
insert into public.catering_dish_category (name, icon, tag, is_required, sort_order, price_20, price_30, price_40, price_50)
values
  ('Chicken',    '&#127831;', 'main',    true,  10, 2700, 3800, 4800, 5900),
  ('Pork',       '&#129385;', 'main',    true,  20, 2700, 3800, 4800, 5900),
  ('Beef',       '&#129385;', 'main',    true,  30, 2700, 3800, 4800, 5900),
  ('Fish',       '&#128031;', 'main',    true,  40, 2400, 3400, 4500, 5600),
  ('Vegetables', '&#129382;', 'main',    true,  50, 2400, 3400, 4500, 5600),
  ('Pasta',      '&#127837;', 'pasta',   true,  60, 2000, 2900, 3800, 4600),
  ('Dessert',    '&#127854;', 'dessert', true,  70, 1400, 2900, 2600, 3200),
  ('Rice',       '&#127834;', 'rice',    false, 80, 600,  900,  1200, 1500)
on conflict do nothing;

insert into public.catering_dish (category_id, name, sort_order)
select c.category_id, d.name, d.sort_order
from public.catering_dish_category c
join (values
  ('Chicken', 'Chicken ala King', 10), ('Chicken', 'Chicken Fillet w/ White Sauce', 20), ('Chicken', 'Garlic Butter Chicken', 30),
  ('Pork', 'Pork with Mushroom', 10), ('Pork', 'Crunchy Pork', 20), ('Pork', 'Pork Caldereta', 30),
  ('Beef', 'Beef Teriyaki', 10), ('Beef', 'Beef Salpicao', 20), ('Beef', 'Beef and Broccoli', 30),
  ('Fish', 'Fish Fillet with Tartar Sauce', 10), ('Fish', 'Sweet and Sour Fish Fillet', 20),
  ('Vegetables', 'Mixed Vegetables in Butter Corn and Carrots', 10), ('Vegetables', 'Potato Marble', 20),
  ('Pasta', 'Spaghetti', 10), ('Pasta', 'Carbonara', 20), ('Pasta', 'Baked Macaroni', 30), ('Pasta', 'Tuna Pesto', 40), ('Pasta', 'Pancit Canton', 50),
  ('Dessert', 'Coffee Jelly', 10), ('Dessert', 'Buko Pandan', 20), ('Dessert', 'Mango Sago', 30), ('Dessert', 'Chocolate Mousse', 40),
  ('Rice', 'Steamed Rice', 10)
) as d(cat_name, name, sort_order) on d.cat_name = c.name
on conflict do nothing;

-- ── Grants + RLS: same admin/manager-write, public-read convention as
-- package/package_category/package_tier (20260628_package_rls_and_grants.sql). ─
grant select, insert, update, delete on public.catering_dish_category to authenticated;
grant select, insert, update, delete on public.catering_dish          to authenticated;
grant select on public.catering_dish_category to anon;
grant select on public.catering_dish          to anon;

alter table public.catering_dish_category enable row level security;

drop policy if exists "Public read active catering categories" on public.catering_dish_category;
create policy "Public read active catering categories" on public.catering_dish_category
  for select using (is_active = true);

drop policy if exists "Admin read all catering categories" on public.catering_dish_category;
create policy "Admin read all catering categories" on public.catering_dish_category
  for select using (
    exists (select 1 from public.profiles p where p.user_id = auth.uid() and p.role in ('admin','manager','staff'))
  );

drop policy if exists "Admin manage catering categories" on public.catering_dish_category;
create policy "Admin manage catering categories" on public.catering_dish_category
  for all
  using (exists (select 1 from public.profiles p where p.user_id = auth.uid() and p.role in ('admin','manager')))
  with check (exists (select 1 from public.profiles p where p.user_id = auth.uid() and p.role in ('admin','manager')));

alter table public.catering_dish enable row level security;

drop policy if exists "Public read active catering dishes" on public.catering_dish;
create policy "Public read active catering dishes" on public.catering_dish
  for select using (is_active = true);

drop policy if exists "Admin read all catering dishes" on public.catering_dish;
create policy "Admin read all catering dishes" on public.catering_dish
  for select using (
    exists (select 1 from public.profiles p where p.user_id = auth.uid() and p.role in ('admin','manager','staff'))
  );

drop policy if exists "Admin manage catering dishes" on public.catering_dish;
create policy "Admin manage catering dishes" on public.catering_dish
  for all
  using (exists (select 1 from public.profiles p where p.user_id = auth.uid() and p.role in ('admin','manager')))
  with check (exists (select 1 from public.profiles p where p.user_id = auth.uid() and p.role in ('admin','manager')));

-- Keep updated_at current on category edits (price changes especially).
create or replace function public.touch_catering_dish_category_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_touch_catering_dish_category on public.catering_dish_category;
create trigger trg_touch_catering_dish_category
  before update on public.catering_dish_category
  for each row
  execute function public.touch_catering_dish_category_updated_at();
