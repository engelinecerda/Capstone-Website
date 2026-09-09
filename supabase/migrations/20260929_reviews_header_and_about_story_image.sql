-- Reviews page header: extends page_header's page_key check constraint the
-- same way 20260807_menu_page_header.sql did for "menu", making the Guest
-- Reviews hero heading/subheading (and image) editable from the existing
-- Page Content > Page Headers card instead of hardcoded in reviews.html.
-- Seeded verbatim from what reviews.html already hardcodes so nothing
-- changes visually until an admin edits it.
alter table public.page_header drop constraint if exists page_header_page_key_check;
alter table public.page_header add constraint page_header_page_key_check
  check (page_key in ('home', 'packages', 'about', 'faqs', 'menu', 'reviews'));

insert into public.page_header (page_key, heading, subheading, image_url, alt_text) values
  ('reviews', 'Guest Reviews', 'See what our guests have to say about their experience',
   '/images/eli coffee binangonan.jpg', 'ELI Coffee Events Cafe interior')
on conflict (page_key) do nothing;

-- About page story image: the photo beside the "Who We Are" text
-- (about.html's .about-story-image, distinct from the page's own hero) has
-- no admin control today. Rather than a new table, this rides on the
-- existing who_we_are about_section row — the same row that already
-- supplies that block's body text (20260806_page_content.sql) — by adding
-- image_url/alt_text columns to about_section, used only by that row.
alter table public.about_section add column if not exists image_url text;
alter table public.about_section add column if not exists alt_text text;

update public.about_section
set image_url = '/images/glorie-gotis.jpg', alt_text = 'ELI Coffee Events Cafe interior'
where section_key = 'who_we_are' and image_url is null;
