-- Menu page content — the 5 scanned menu-category images (Sulit Picks,
-- Pizza/Appetizers/Waffles, Mains/Pasta/Sets, Drinks, Tiramisu) and the
-- Elite Card membership banner were still hardcoded in menu.html even after
-- 20260806_page_content.sql/20260807_menu_page_header.sql wired up the
-- Menu page's hero. Same shape as landing_service
-- (20260807_business_profile_and_landing.sql) — image + heading, admin can
-- add/reorder/remove freely, not a fixed 5-slot list.

create table if not exists public.menu_section (
  id         uuid primary key default gen_random_uuid(),
  heading    text not null,
  image_url  text not null,
  alt_text   text not null,
  is_active  boolean not null default true,
  sort_order int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id)
);

insert into public.menu_section (heading, image_url, alt_text, sort_order)
select * from (values
  ('Sulit Picks Meals', '/images/menu/sulit-picks.jpg',
   'ELI Coffee Sulit Picks budget meals menu with prices', 0),
  ('Pizzas / Appetizers / Waffles', '/images/menu/pizza-appetizers-waffles.jpg',
   'ELI Coffee pizza, appetizer, and waffle menu with prices', 1),
  ('Main Dish / Pastas / Salu-Salo Sets', '/images/menu/main-pasta-sets.jpg',
   'ELI Coffee main dish, pasta, and salu-salo set menu with prices', 2),
  ('Drinks', '/images/menu/drinks.png',
   'ELI Coffee drinks menu — cold brew, blended, matcha, fruit tea, juices, hot coffee and upgrades', 3),
  ('Tiramisu by ELI Coffee', '/images/menu/tiramisu.png',
   'Tiramisu by ELI Coffee — dessert menu with sizes and prices', 4)
) as seed(heading, image_url, alt_text, sort_order)
where not exists (select 1 from public.menu_section);

-- Singleton, same pattern as business_contact — one Elite Card banner, not a
-- repeatable list. is_active lets the admin hide the whole banner without
-- deleting its configured text/image.
create table if not exists public.menu_banner (
  id          boolean primary key default true,
  label       text not null default 'Members Only',
  heading     text not null default 'Elite Card',
  description text not null default 'Get 20% off on all orders. Elite price shown on menu sheets is exclusive to card holders.',
  image_url   text,
  alt_text    text,
  is_active   boolean not null default true,
  updated_at  timestamptz not null default now(),
  updated_by  uuid references auth.users(id),
  constraint singleton check (id)
);

insert into public.menu_banner (id, image_url, alt_text)
values (true, '/images/menu/elite-card.png', 'ELI Coffee Elite Membership Card — 20% off for members')
on conflict (id) do nothing;

-- ═══════════════════════════════════════════════════════════════════════════
-- RLS — public read (menu_section filtered to active; menu_banner is a
-- singleton so the customer page checks is_active itself), admin-only write.
-- ═══════════════════════════════════════════════════════════════════════════

alter table public.menu_section enable row level security;
drop policy if exists "Public read active menu sections" on public.menu_section;
create policy "Public read active menu sections" on public.menu_section for select using (is_active = true);
drop policy if exists "Admin read all menu sections" on public.menu_section;
create policy "Admin read all menu sections" on public.menu_section for select using (get_my_role() = 'admin');
drop policy if exists "Admin manage menu sections" on public.menu_section;
create policy "Admin manage menu sections" on public.menu_section
  for all using (get_my_role() = 'admin') with check (get_my_role() = 'admin');

alter table public.menu_banner enable row level security;
drop policy if exists "Public read menu banner" on public.menu_banner;
create policy "Public read menu banner" on public.menu_banner for select using (true);
drop policy if exists "Admin manage menu banner" on public.menu_banner;
create policy "Admin manage menu banner" on public.menu_banner
  for all using (get_my_role() = 'admin') with check (get_my_role() = 'admin');
