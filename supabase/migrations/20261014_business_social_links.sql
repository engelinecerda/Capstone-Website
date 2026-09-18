-- Contact & Social was rigidly limited to exactly two fixed columns on
-- business_contact (facebook_url, instagram_url) — an admin could never add
-- a third platform (TikTok, WhatsApp, LinkedIn, a booking line, etc.)
-- without a code change. This adds a repeatable list, table-shaped exactly
-- like business_location (20260807_business_profile_and_landing.sql) so the
-- same admin list/modal pattern (render list, add/edit modal, reorder,
-- active toggle, remove) can be copied directly.
--
-- facebook_url/instagram_url on business_contact are left untouched — they
-- still drive the two fixed social icons in the footer (footer_content.js),
-- which every page's static footer markup has exactly two <a> slots for.
-- This table is for anything ADDITIONAL beyond those two.
create table if not exists public.business_social_link (
  id          uuid primary key default gen_random_uuid(),
  label       text not null,
  url         text not null,
  is_active   boolean not null default true,
  sort_order  int not null default 0,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

alter table public.business_social_link enable row level security;

drop policy if exists "Public read active social links" on public.business_social_link;
create policy "Public read active social links" on public.business_social_link
  for select using (is_active = true);

drop policy if exists "Admin read all social links" on public.business_social_link;
create policy "Admin read all social links" on public.business_social_link
  for select using (get_my_role() = 'admin');

drop policy if exists "Admin manage social links" on public.business_social_link;
create policy "Admin manage social links" on public.business_social_link
  for all using (get_my_role() = 'admin') with check (get_my_role() = 'admin');
