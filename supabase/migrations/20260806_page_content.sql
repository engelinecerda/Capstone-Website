-- Page Content (Maintenance Module, Phase 1 of that module — presentation
-- config only, no maintenance-mode/announcement behaviour).
--
-- Replaces hardcoded page heroes, the homepage gallery, About's long-form
-- text, and the FAQ list with admin-editable rows. Seeded verbatim from
-- what's live today so nothing changes visually until an admin edits it.
--
-- Images use the same Cloudinary pipeline as package_photo (image_url =
-- Cloudinary secure_url), not Supabase Storage — see js/image_upload.js.
-- Deliberately does NOT store café name/address/contact/hours (that's
-- "Business Profile", which doesn't exist yet and is a separate future
-- build) — every hardcoded contact/address line stays exactly as-is.

create table if not exists public.page_header (
  id         uuid primary key default gen_random_uuid(),
  page_key   text not null unique check (page_key in ('home', 'packages', 'about', 'faqs')),
  heading    text,
  subheading text,
  image_url  text,
  alt_text   text,
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id)
);

insert into public.page_header (page_key, heading, subheading, image_url, alt_text) values
  ('home', 'Where every sip tells a story',
   'Specialty coffee, desserts, and cozy lounge spaces for meetups, study sessions, and private gatherings.',
   '/images/637347619_904793605590427_6779978724130647558_n.jpg', 'ELI Coffee Events Cafe at night'),
  ('packages', 'Our Packages', 'Curated experiences for every celebration',
   '/images/wedding.png', 'ELI Coffee event packages'),
  ('about', 'Our Story', 'Founded with passion. Built for community.',
   '/images/about-background-img.jpg', 'ELI Coffee Events Cafe'),
  ('faqs', 'Frequently Asked', 'Find answers to common questions about our services and events',
   '/images/625975201_26971266315797097_6450646982903854248_n.jpg', 'ELI Coffee Events Cafe')
on conflict (page_key) do nothing;

create table if not exists public.gallery_image (
  id         uuid primary key default gen_random_uuid(),
  image_url  text not null,
  caption    text,
  alt_text   text not null,
  is_active  boolean not null default true,
  sort_order int not null default 0,
  created_at timestamptz not null default now()
);

insert into public.gallery_image (image_url, alt_text, sort_order)
select * from (values
  ('/images/snack bar corner.jpg', 'ELI Coffee lounge', 0),
  ('/images/625975201_26971266315797097_6450646982903854248_n.jpg', 'Coffee and desserts', 1),
  ('/images/crop-background-img.jpg', 'Event decor', 2),
  ('/images/629336028_26971264995797229_7811559806777201812_n.jpg', 'Food spread', 3),
  ('/images/vip.jpg', 'Private gathering', 4),
  ('/images/cafe.jpg', 'Interior dining', 5)
) as seed(image_url, alt_text, sort_order)
where not exists (select 1 from public.gallery_image);

create table if not exists public.about_section (
  section_key text primary key check (section_key in ('who_we_are', 'values', 'mission')),
  title       text not null,
  body        text,
  sort_order  int not null default 0,
  updated_at  timestamptz not null default now(),
  updated_by  uuid references auth.users(id)
);

insert into public.about_section (section_key, title, body, sort_order) values
  ('who_we_are', 'Who We Are',
$body$At ELI Coffee Events Café, we believe that coffee tastes best when shared with community, creativity, and celebration. More than just a café, we are a welcoming space in Binangonan where people gather not only for great brews and homemade treats, but also for meaningful experiences.

Founded with passion by Glorie Gotis, ELI Coffee has grown into a hub for events, performances, and gatherings. Whether it's an intimate open mic night, a cozy book club, or a full-scale celebration, our café transforms into the perfect venue to bring people together.$body$,
   0),
  ('values', 'Our Values',
$body$Quality Coffee
We source and brew only the finest coffee beans to ensure every cup is exceptional.

Memorable Moments
We're passionate about creating beautiful memories for you and your guests.

Professional Service
Our experienced team delivers top-tier service for every event, big or small.

Community Focus
We're proud to serve the Binangonan community and surrounding areas.$body$,
   1),
  ('mission', 'Our Mission',
$body$To create a welcoming space where people can come together to enjoy great coffee, connect with others, and celebrate life's moments — one cup, one gathering, one memory at a time.$body$,
   2)
on conflict (section_key) do nothing;

create table if not exists public.faq (
  id         uuid primary key default gen_random_uuid(),
  question   text not null,
  answer     text not null,
  is_active  boolean not null default true,
  sort_order int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

insert into public.faq (question, answer, sort_order)
select * from (values
  ('Do you accept walk-in reservations?',
   'We highly recommend booking in advance to secure your spot, but we do accept walk-ins if tables are available.', 0),
  ('Can I host private events at ELI Coffee?',
   'Yes! Our café is designed for events. We offer packages for birthdays, meetings, and special gatherings. Contact us to customize your event.', 1),
  ('Do you offer catering services?',
   'We provide catering for small and large events. Our menu can be tailored to suit your occasion, from coffee and pastries to full meals.', 2),
  ('Is there parking available?',
   'Yes, we have designated parking spaces for guests. For larger events, we can assist with additional parking arrangements nearby.', 3),
  ('Do you have Wi-Fi for customers?',
   'Absolutely! Free Wi-Fi is available for all guests, making our café a great spot for meetings, study sessions, or remote work.', 4),
  ('What payment methods do you accept?',
   'We accept cash, major credit/debit cards, and popular e-wallets like GCash and Maya for your convenience.', 5),
  ('How far in advance should I book an event?',
   'We recommend booking at least 2–4 weeks in advance to ensure availability, especially for weekends and holidays. For larger events, reaching out 1–2 months ahead is ideal.', 6),
  ('What is the cancellation and rescheduling policy?',
   'All payments are strictly non-refundable once verified. Rescheduling requests are subject to availability and require a rescheduling fee of ₱3,000. Please contact us as early as possible if you need to adjust your booking date.', 7)
) as seed(question, answer, sort_order)
where not exists (select 1 from public.faq);

-- ═══════════════════════════════════════════════════════════════════════════
-- RLS — public read (gallery/faq only active rows), admin-only write.
-- ═══════════════════════════════════════════════════════════════════════════

alter table public.page_header enable row level security;
drop policy if exists "Public read page headers" on public.page_header;
create policy "Public read page headers" on public.page_header for select using (true);
drop policy if exists "Admin manage page headers" on public.page_header;
create policy "Admin manage page headers" on public.page_header
  for all using (get_my_role() = 'admin') with check (get_my_role() = 'admin');

alter table public.gallery_image enable row level security;
drop policy if exists "Public read active gallery images" on public.gallery_image;
create policy "Public read active gallery images" on public.gallery_image for select using (is_active = true);
drop policy if exists "Admin read all gallery images" on public.gallery_image;
create policy "Admin read all gallery images" on public.gallery_image for select using (get_my_role() = 'admin');
drop policy if exists "Admin manage gallery images" on public.gallery_image;
create policy "Admin manage gallery images" on public.gallery_image
  for all using (get_my_role() = 'admin') with check (get_my_role() = 'admin');

alter table public.about_section enable row level security;
drop policy if exists "Public read about sections" on public.about_section;
create policy "Public read about sections" on public.about_section for select using (true);
drop policy if exists "Admin manage about sections" on public.about_section;
create policy "Admin manage about sections" on public.about_section
  for all using (get_my_role() = 'admin') with check (get_my_role() = 'admin');

alter table public.faq enable row level security;
drop policy if exists "Public read active faqs" on public.faq;
create policy "Public read active faqs" on public.faq for select using (is_active = true);
drop policy if exists "Admin read all faqs" on public.faq;
create policy "Admin read all faqs" on public.faq for select using (get_my_role() = 'admin');
drop policy if exists "Admin manage faqs" on public.faq;
create policy "Admin manage faqs" on public.faq
  for all using (get_my_role() = 'admin') with check (get_my_role() = 'admin');
