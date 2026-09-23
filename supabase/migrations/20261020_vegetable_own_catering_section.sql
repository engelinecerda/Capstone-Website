-- "Vegetables" was seeded as a main-tagged category (20260820_catering_menu.sql),
-- so it counted as one of the protein choices in the Main Dish tab switcher
-- and toward the package's main-dish max (catering_main_dish_max). Per menu
-- review, Vegetable should instead be its own selection group — same tier as
-- Pasta/Dessert/Rice/Drinks — with its own required/optional + min/max rule,
-- independent of how many proteins the customer picks for Main Dish.
--
-- This only widens the `tag` check constraints (both tables already enforce
-- the same fixed list) and retags the existing "Vegetables" category/rows.
-- The admin's Selection Group dropdown and the customer-facing builder are
-- updated separately (super_admin_packages.html/js, reservations.js) to
-- recognize 'vegetable' as a real section.

alter table public.catering_dish_category
  drop constraint if exists catering_dish_category_tag_check;
alter table public.catering_dish_category
  add constraint catering_dish_category_tag_check
    check (tag in ('main','pasta','dessert','rice','drinks','vegetable','addon'));

alter table public.catering_section_rule
  drop constraint if exists catering_section_rule_tag_check;
alter table public.catering_section_rule
  add constraint catering_section_rule_tag_check
    check (tag in ('main','pasta','dessert','rice','drinks','vegetable','addon'));

-- Move every existing "Vegetables" category out of Main Dish and into its
-- own Vegetable section. `is_required` carries over as-is (it was seeded
-- true, so Vegetable stays required unless an admin unchecks it).
update public.catering_dish_category
set tag = 'vegetable',
    updated_at = now()
where tag = 'main'
  and name = 'Vegetables';

-- Any package that already had an explicit "main" section_rule (min/max)
-- has nothing to migrate here — that rule only ever governed the Main
-- Dish max, and stays exactly as configured now that Vegetable no longer
-- shares the tag. No new 'vegetable' section_rule rows are inserted here:
-- an absent row just falls back to "required if any of its categories is
-- required, uncapped otherwise" (see getCateringSectionRule in
-- reservations.js), which reproduces the previous single-category
-- behavior with no extra admin step needed.
