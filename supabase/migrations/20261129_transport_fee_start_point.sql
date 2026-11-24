-- Transport fee starting point (per branch).
--
-- Until now the transport fee was measured from EVERY active branch that had
-- map coordinates, so pinning a second branch (e.g. Antipolo) would silently
-- start pricing offsite bookings from it. The ●/○ button on a branch cannot be
-- used to prevent that: it sets is_active, which also hides the branch from
-- the homepage Find Us section and the footer.
--
-- This adds an explicit per-branch flag. Only branches with
-- transport_origin = true (and a map pin) are used as a starting point by:
--   * the calculate-transport-fee edge function,
--   * js/transport_fee.js (booking-form fallback estimate + Payment Settings
--     worked example),
--   * the booking form and Payment Settings notes.
-- A branch can still be active, shown to customers and pinned without ever
-- affecting a transport fee. Bookings already made are unaffected: the pin,
-- distance and fee are frozen on each reservation.
--
-- Deploy order: run this migration FIRST, then deploy the
-- calculate-transport-fee edge function, then push the website.

alter table public.business_location
  add column if not exists transport_origin boolean not null default false;

comment on column public.business_location.transport_origin is
  'When true (and the branch has a map pin), offsite transport fees are measured from this branch. Independent of is_active, which only controls whether the branch is shown to customers.';

-- Backfill: the system currently serves offsite events from the Binangonan
-- branch only, so flag the Binangonan / main branch (if it already has a pin).
-- Every other branch stays off.
update public.business_location
set transport_origin = true
where latitude is not null
  and longitude is not null
  and (name ilike '%binangonan%' or branch_tag ilike 'main%');

-- A starting point must have a pin (the same rule the admin form enforces).
alter table public.business_location
  drop constraint if exists business_location_transport_origin_needs_pin;
alter table public.business_location
  add constraint business_location_transport_origin_needs_pin
  check (not transport_origin or (latitude is not null and longitude is not null));
