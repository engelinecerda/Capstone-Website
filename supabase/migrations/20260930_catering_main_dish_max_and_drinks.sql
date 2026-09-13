-- Two catering-menu fixes from the Eli Events & Catering menu review:
--
-- 1. The physical menu's "Catering Buffet Set Up" inclusion is 3 main
--    dishes, 1 pasta, rice, dessert, and a drink — but the customer
--    builder only ever enforced "at least 1" main dish, with no cap.
--    The cap is a whole-section rule (applies across all main-tagged
--    categories combined), not a per-category one, so it lives on the
--    package itself alongside the existing `uses_catering_menu` flag
--    rather than being duplicated onto every protein category row.
--
-- 2. "Drinks" was already a valid `tag` value (and already an option in
--    the admin's Selection Group dropdown) but no Drinks category was
--    ever seeded, and the customer builder never rendered a drinks
--    section regardless. This adds a starter category so the section
--    isn't empty on first load — rename/replace the dishes from the
--    Catering Menu admin screen same as any other category.

alter table public.package
  add column if not exists catering_main_dish_max integer not null default 3
    check (catering_main_dish_max > 0);

comment on column public.package.catering_main_dish_max is
  'Customer-facing cap on how many main-dish (protein) selections the buffet builder allows for this catering package. Editable from Inventory > Catering Menu.';

-- Seed a starter Drinks category on every package that already uses the
-- catering menu, mirroring the same "current hardcoded menu" backfill
-- pattern 20260820_catering_menu.sql used. Prices are placeholders
-- (matches Rice's bracket) — update from the admin screen.
insert into public.catering_dish_category (package_id, name, icon, tag, is_required, sort_order, price_20, price_30, price_40, price_50)
select package_id, 'Drinks', '&#129380;', 'drinks', true, 90, 600, 900, 1200, 1500
from public.package
where uses_catering_menu = true
on conflict do nothing;

insert into public.catering_dish (category_id, name, sort_order)
select c.category_id, d.name, d.sort_order
from public.catering_dish_category c
cross join (values
  ('Iced Tea', 10),
  ('Bottled Water', 20)
) as d(name, sort_order)
where c.tag = 'drinks'
on conflict do nothing;
