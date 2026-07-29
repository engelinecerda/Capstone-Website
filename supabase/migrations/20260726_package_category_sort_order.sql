-- Fix: js/super_admin_packages.js orders both package_category and package
-- by sort_order (categories/packages are meant to be admin-reorderable,
-- controlling display order in the customer catalogue), but
-- 20260725_bookable_inventory.sql only added sort_order to the new tables
-- (venue, package_photo) — package_category and package never had it.
alter table public.package_category
  add column if not exists sort_order int not null default 0;

alter table public.package
  add column if not exists sort_order int not null default 0;
