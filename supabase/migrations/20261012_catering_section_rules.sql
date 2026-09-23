-- Generalizes the "Max main dishes included" (package.catering_main_dish_max)
-- and per-category "Required" checkbox (catering_dish_category.is_required)
-- into one admin-editable restriction per catering SECTION (tag) instead of
-- being spread across a package-level column and a category-level flag —
-- see chat discussion: "Add Restriction" pattern on the Catering Menu screen.
--
-- catering_section_rule = one row per (package_id, tag) that has an explicit
--   restriction configured. Two independent counts, both optional:
--     min_select — customer must pick at least this many dishes across every
--       active category sharing that tag before checkout (0 = optional).
--     max_select — hard cap on how many the buffet builder lets them pick
--       (null = unlimited, bounded only by how many categories exist).
--   A tag with no row here has no explicit restriction — the customer
--   front-end (reservations.js) falls back to the legacy derivation
--   (catering_dish_category.is_required OR'd across the tag, and
--   package.catering_main_dish_max for 'main') so packages that predate
--   this table keep behaving exactly as before until an admin adds a
--   restriction for them explicitly.
--
-- Both legacy fields are left in place — is_required still drives the
-- category modal's own "Required" checkbox (a per-category default), and
-- catering_main_dish_max is backfilled below rather than dropped, in case
-- anything still reads it directly. New restriction editing happens here.

create table if not exists public.catering_section_rule (
  package_id  uuid not null references public.package(package_id) on delete cascade,
  tag         text not null check (tag in ('main','pasta','dessert','rice','drinks','addon')),
  min_select  integer not null default 0 check (min_select >= 0),
  max_select  integer check (max_select is null or (max_select > 0 and max_select >= min_select)),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  primary key (package_id, tag)
);

-- ── Grants + RLS: same admin/manager-write, public-read convention as
-- catering_dish_category (20260820_catering_menu.sql). ─────────────────────
grant select, insert, update, delete on public.catering_section_rule to authenticated;
grant select on public.catering_section_rule to anon;

alter table public.catering_section_rule enable row level security;

drop policy if exists "Public read catering section rules" on public.catering_section_rule;
create policy "Public read catering section rules" on public.catering_section_rule
  for select using (true);

drop policy if exists "Admin manage catering section rules" on public.catering_section_rule;
create policy "Admin manage catering section rules" on public.catering_section_rule
  for all
  using (exists (select 1 from public.profiles p where p.user_id = auth.uid() and p.role in ('admin','manager')))
  with check (exists (select 1 from public.profiles p where p.user_id = auth.uid() and p.role in ('admin','manager')));

create or replace function public.touch_catering_section_rule_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_touch_catering_section_rule on public.catering_section_rule;
create trigger trg_touch_catering_section_rule
  before update on public.catering_section_rule
  for each row
  execute function public.touch_catering_section_rule_updated_at();

-- Backfill so every existing catering-enabled package keeps its current
-- customer-facing behavior as an explicit row instead of an implicit
-- fallback: one row per distinct tag present in that package's categories,
-- min_select = 1 if any category of that tag is currently required, else 0.
insert into public.catering_section_rule (package_id, tag, min_select, max_select)
select
  c.package_id,
  c.tag,
  case when bool_or(c.is_required) then 1 else 0 end as min_select,
  null::integer as max_select
from public.catering_dish_category c
where c.package_id is not null
group by c.package_id, c.tag
on conflict (package_id, tag) do nothing;

-- 'main' is a special case pre-dating this table: the whole-section cap
-- already lived on package.catering_main_dish_max, and the existing
-- customer builder treats that as both the required count AND the max
-- (isCateringSectionValid() requires reaching it) — carry both over so
-- behavior doesn't change the moment this migration runs.
insert into public.catering_section_rule (package_id, tag, min_select, max_select)
select p.package_id, 'main', p.catering_main_dish_max, p.catering_main_dish_max
from public.package p
where p.uses_catering_menu = true
on conflict (package_id, tag) do update
  set min_select = excluded.min_select,
      max_select = excluded.max_select;
