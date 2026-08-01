-- Service Charge Configuration (Payment Settings) — a percentage added on
-- top of package price, covering utilities and staff. Global default lives
-- in system_settings.payment_rules (JSON blob, alongside reschedule_fee /
-- cancellation_fee_onsite / cancellation_fee_offsite — no code change here,
-- js/admin_payment_options.js already reads/writes that blob), with an
-- optional per-category override.
--
-- IMPORTANT — category vs. location: package_category does NOT map to
-- location_type (confirmed by reading actual seed data — onsite, offsite,
-- and 'both' packages are mixed within the same category). A category
-- override alone cannot express "onsite-only". Resolution therefore always
-- checks the booking's actual location FIRST:
--   service_pct = case when reservations.location_type = 'offsite' then 0
--                       else coalesce(package_category.service_charge_percent,
--                                     payment_rules.service_charge_percent)
--                  end
-- The 0% for offsite is a PENDING-CONFIRMATION ASSUMPTION (poster shows 10%
-- for onsite "Private Gathering" packages, described as covering utilities
-- & employees — the manager hasn't confirmed whether it applies offsite).
-- This resolution logic lives in reservations.html's resolveServiceCharge();
-- there is nothing to enforce here at the DB level since total_price
-- (which already includes the charge) is client-computed and trusted, same
-- as every other pricing figure on reservations today.

alter table public.package_category
  add column if not exists service_charge_percent numeric(5,2)
    check (service_charge_percent is null or service_charge_percent between 0 and 100);
-- null = inherit the global default (system_settings.payment_rules.
-- service_charge_percent). Left null for every existing category on
-- purpose — there is no category that cleanly IS "the offsite one", so
-- onsite-only intent is carried by location_type, not by seeding a 0%
-- override here.

alter table public.reservations
  add column if not exists service_charge_percent numeric(5,2),
  add column if not exists service_charge_amount  numeric(12,2);
-- Snapshot columns, written by the client alongside total_price at booking
-- submission (same trust model as total_price itself — see
-- 20260731_reservation_package_integrity.sql's floor-check trigger, which
-- this doesn't change). Later edits to the global default or a category
-- override only affect new bookings; existing rows keep what was true when
-- they were created, matching every other snapshot in this system.
