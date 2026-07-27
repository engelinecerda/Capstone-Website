-- Business Profile (real implementation, replacing the "Not yet
-- implemented" placeholder at admin/system/business.html) + Landing Page
-- "What We Offer" services + the Home page's Our Story teaser text.
--
-- business_location / business_contact are identity data — the exact thing
-- the Page Content build (20260806_page_content.sql) deliberately did not
-- own. Both Find Us and every page's footer read from these instead of
-- keeping their own hardcoded copy, which is what actually fixes the
-- footer's 7-page duplication (index/about/faqs/packages/reservations/
-- reviews/menu — confirmed by a repo-wide grep for footer-new-grid).

create table if not exists public.business_location (
  id          uuid primary key default gen_random_uuid(),
  branch_tag  text,
  name        text not null,
  address     text not null,
  hours_label text,
  is_active   boolean not null default true,
  sort_order  int not null default 0,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

insert into public.business_location (branch_tag, name, address, hours_label, sort_order)
select * from (values
  ('Main Branch', 'ELI Coffee Events Cafe Binangonan', '2nd Floor, Pearl Building, National Road, Calumpang, Binangonan, Rizal', 'Daily · 1:00 PM – 10:00 PM', 0),
  ('Branch', 'ELI Coffee Antipolo', '2nd Floor, Pobel Building, M.L. Quezon Avenue Extension, Antipolo City', 'Daily · 1:00 PM – 2:00 AM', 1)
) as seed(branch_tag, name, address, hours_label, sort_order)
where not exists (select 1 from public.business_location);

create table if not exists public.business_contact (
  id                boolean primary key default true,
  brand_description text,
  phone             text,
  email             text,
  facebook_url      text,
  instagram_url     text,
  updated_at        timestamptz not null default now(),
  updated_by        uuid references auth.users(id),
  constraint singleton check (id)
);

insert into public.business_contact (id, brand_description, phone, email, facebook_url, instagram_url)
values (
  true,
  'Your go-to events cafe in Binangonan, Rizal. Specialty coffee, desserts, and private event spaces crafted for every occasion.',
  '0917 562 0306 | 0917 562 0308',
  'elicoffeetea@gmail.com',
  'https://www.facebook.com/elicoffeeph',
  'https://www.instagram.com/elicoffeeph/'
)
on conflict (id) do nothing;

create table if not exists public.landing_service (
  id          uuid primary key default gen_random_uuid(),
  image_url   text,
  title       text not null,
  description text,
  link_url    text,
  link_label  text,
  is_active   boolean not null default true,
  sort_order  int not null default 0,
  created_at  timestamptz not null default now()
);

insert into public.landing_service (image_url, title, description, link_url, link_label, sort_order)
select * from (values
  ('/images/group-order.jpg', 'Cafe & Lounge',
   'A cozy spot for relaxation, conversation, or the perfect cup. Enjoy specialty coffee, teas, and homemade desserts in a warm, welcoming atmosphere.',
   '/menu.html', 'View Menu', 0),
  ('/images/crop-background-img.jpg', 'Private Events',
   'Book the lounge exclusively for birthdays, bridal showers, team gatherings, and more. We handle the setup so you can focus on the moments that matter.',
   '/packages.html', 'View packages', 1),
  ('/images/catering img.jpg', 'Catering',
   'Customizable menus for weddings, birthdays, and corporate events. Our kitchen brings the ELI Coffee experience directly to your chosen venue.',
   '/packages.html', 'Get a quote', 2)
) as seed(image_url, title, description, link_url, link_label, sort_order)
where not exists (select 1 from public.landing_service);

-- menu.html was wired up (loadPageHeader(supabase, 'menu', ...)) after
-- 20260806_page_content.sql shipped, with page_key CHECKed to only
-- ('home','packages','about','faqs') — widen it and seed the menu row so
-- that call actually resolves instead of silently no-op'ing.
alter table public.page_header drop constraint if exists page_header_page_key_check;
alter table public.page_header add constraint page_header_page_key_check
  check (page_key in ('home', 'packages', 'about', 'faqs', 'menu'));

insert into public.page_header (page_key, heading, subheading, image_url, alt_text)
values ('menu', 'Our Menu', 'Tap any menu to zoom in', '/images/group-order-4.jpg', 'ELI Coffee Events Cafe interior')
on conflict (page_key) do nothing;

-- Our Story's Home-page teaser reuses about_section (same title+markdown-body
-- shape, same admin editor and renderer as Who We Are / Our Values / Our
-- Mission) — just widen the allowed section_key set.
alter table public.about_section drop constraint if exists about_section_section_key_check;
alter table public.about_section add constraint about_section_section_key_check
  check (section_key in ('who_we_are', 'values', 'mission', 'home_teaser'));

insert into public.about_section (section_key, title, body, sort_order) values
  ('home_teaser', 'Home Page Teaser',
$body$ELI Coffee Events Cafe is more than your neighborhood coffee shop. We are a warm, inviting space in the heart of Binangonan, Rizal, designed for those who appreciate the finer moments — a quiet afternoon with a book, a milestone celebration with loved ones, or an intimate corporate gathering.

From handcrafted specialty beverages to full event catering, every detail is curated with care to give you an experience worth returning to.$body$,
   -1)
on conflict (section_key) do nothing;

-- ═══════════════════════════════════════════════════════════════════════════
-- RLS — public read (locations/services filtered to active), admin-only write.
-- ═══════════════════════════════════════════════════════════════════════════

alter table public.business_location enable row level security;
drop policy if exists "Public read active locations" on public.business_location;
create policy "Public read active locations" on public.business_location for select using (is_active = true);
drop policy if exists "Admin read all locations" on public.business_location;
create policy "Admin read all locations" on public.business_location for select using (get_my_role() = 'admin');
drop policy if exists "Admin manage locations" on public.business_location;
create policy "Admin manage locations" on public.business_location
  for all using (get_my_role() = 'admin') with check (get_my_role() = 'admin');

alter table public.business_contact enable row level security;
drop policy if exists "Public read business contact" on public.business_contact;
create policy "Public read business contact" on public.business_contact for select using (true);
drop policy if exists "Admin manage business contact" on public.business_contact;
create policy "Admin manage business contact" on public.business_contact
  for all using (get_my_role() = 'admin') with check (get_my_role() = 'admin');

alter table public.landing_service enable row level security;
drop policy if exists "Public read active services" on public.landing_service;
create policy "Public read active services" on public.landing_service for select using (is_active = true);
drop policy if exists "Admin read all services" on public.landing_service;
create policy "Admin read all services" on public.landing_service for select using (get_my_role() = 'admin');
drop policy if exists "Admin manage services" on public.landing_service;
create policy "Admin manage services" on public.landing_service
  for all using (get_my_role() = 'admin') with check (get_my_role() = 'admin');
