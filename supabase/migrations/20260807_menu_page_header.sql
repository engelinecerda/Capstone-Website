-- Adds "menu" as a valid page_header.page_key so the Menu page's hero
-- (currently hardcoded in menu.html) becomes admin-editable from the
-- existing Page Content > Page Headers card, same as home/packages/about/
-- faqs (20260806_page_content.sql). Seeded verbatim from what menu.html
-- already hardcodes so nothing changes visually until an admin edits it.

alter table public.page_header drop constraint if exists page_header_page_key_check;
alter table public.page_header add constraint page_header_page_key_check
  check (page_key in ('home', 'packages', 'about', 'faqs', 'menu'));

insert into public.page_header (page_key, heading, subheading, image_url, alt_text) values
  ('menu', 'Our Menu', 'Tap any menu to zoom in', '/images/group-order-4.jpg', 'ELI Coffee Events Cafe interior')
on conflict (page_key) do nothing;
