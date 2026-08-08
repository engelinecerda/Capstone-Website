-- The catering-menu category modal (super_admin_packages.html) treats the
-- Icon field as optional — no asterisk, no client-side requirement — but
-- catering_dish_category.icon was created `not null default '&#127860;'`.
-- The save handler sends `icon: null` when the field is left blank
-- (js/super_admin_packages.js), which violates that NOT NULL constraint and
-- fails the save. Admins shouldn't have to come up with an icon just to add
-- a catering category, so drop the requirement entirely.

alter table public.catering_dish_category
  alter column icon drop not null,
  alter column icon drop default;
