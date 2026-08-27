-- Scopes the catering menu (catering_dish_category/catering_dish) to a
-- specific package instead of being one global menu shared by every
-- "Catering"-category package, and adds an explicit flag on `package` so
-- the admin UI (and, later, any other code) can tell "this package needs a
-- foods & drinks menu" without guessing from the category name.
--
-- Backfill strategy: today there is exactly one catering package, and the
-- app currently identifies it the same way reservations.html does — the
-- first active package under a category whose name contains "cater". We
-- reuse that same heuristic here so existing data lines up automatically;
-- if it doesn't match anything in your data, package_id is simply left
-- null and you assign it once from the new "Catering Menu" admin screen.

alter table public.package
  add column if not exists uses_catering_menu boolean not null default false;

alter table public.catering_dish_category
  add column if not exists package_id uuid references public.package(package_id) on delete cascade;

create index if not exists idx_catering_dish_category_package on public.catering_dish_category(package_id);

do $$
declare
  detected_package_id uuid;
begin
  select p.package_id into detected_package_id
  from public.package p
  join public.package_category pc on pc.package_category_id = p.package_category_id
  where pc.category_name ilike '%cater%'
    and p.is_active = true
  order by p.sort_order asc
  limit 1;

  if detected_package_id is not null then
    update public.package
       set uses_catering_menu = true
     where package_id = detected_package_id;

    update public.catering_dish_category
       set package_id = detected_package_id
     where package_id is null;
  end if;
end $$;
