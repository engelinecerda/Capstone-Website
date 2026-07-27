-- About page "What We Stand For" values — was rendered from
-- about_section.section_key='values' free-text body (parsed the same way
-- as Who We Are / Mission, via renderPolicyBlocks/parsePolicyBody), which
-- is why the public page showed a plain stacked text list instead of the
-- icon card grid that about.html originally hardcoded (see
-- .values-grid--freeform in css/about.css). This table replaces that path
-- with a real repeatable label + description + icon list, so Values always
-- renders as icon cards. The about_section 'values' row is left in place
-- (harmless, no longer read by any admin UI or customer page) rather than
-- deleted, since deleting rows isn't necessary to stop using them.

create table if not exists public.about_value (
  id          uuid primary key default gen_random_uuid(),
  label       text not null,
  description text not null,
  -- Curated set only — never freeform text, so a bad icon name can't
  -- silently render nothing on the customer page. 'ti-circle-check' is the
  -- fallback for any value an admin adds before picking a real icon.
  icon        text not null default 'ti-circle-check' check (icon in (
    'ti-coffee', 'ti-heart', 'ti-award', 'ti-users', 'ti-leaf',
    'ti-sparkles', 'ti-shield-check', 'ti-clock', 'ti-circle-check'
  )),
  is_active   boolean not null default true,
  sort_order  int not null default 0,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  updated_by  uuid references auth.users(id)
);

insert into public.about_value (label, description, icon, sort_order)
select * from (values
  ('Quality Coffee', 'We source and brew only the finest coffee beans to ensure every cup is exceptional.', 'ti-coffee', 0),
  ('Memorable Moments', 'We''re passionate about creating beautiful memories for you and your guests.', 'ti-heart', 1),
  ('Professional Service', 'Our experienced team delivers top-tier service for every event, big or small.', 'ti-award', 2),
  ('Community Focus', 'We''re proud to serve the Binangonan community and surrounding areas.', 'ti-users', 3)
) as seed(label, description, icon, sort_order)
where not exists (select 1 from public.about_value);

alter table public.about_value enable row level security;
drop policy if exists "Public read active values" on public.about_value;
create policy "Public read active values" on public.about_value for select using (is_active = true);
drop policy if exists "Admin read all values" on public.about_value;
create policy "Admin read all values" on public.about_value for select using (get_my_role() = 'admin');
drop policy if exists "Admin manage values" on public.about_value;
create policy "Admin manage values" on public.about_value
  for all using (get_my_role() = 'admin') with check (get_my_role() = 'admin');
