-- Transport fee for offsite bookings (distance-based, per km).
--
-- How it fits together
--   * Settings live in system_settings.payment_rules (the same JSON blob as the
--     other fees) under transport_fee_enabled / transport_free_km /
--     transport_rate_per_km / transport_max_fee / transport_road_factor — no
--     schema change needed for those; Payment Settings reads and writes them.
--   * The distance is measured from the NEAREST branch to the pin the customer
--     drops on the booking map, so branches need coordinates
--     (business_location.latitude / longitude, set in Business profile).
--   * The fee is computed in the booking form and frozen on the reservation —
--     same trust model as service_charge_* and discount_* — so a later change
--     to the rate never reprices an existing booking or its signed contract.
--     It is included in reservations.total_price (added AFTER the discount and
--     the service charge, so neither applies to it). The existing price-floor
--     trigger only checks a lower bound, so a higher total is accepted as is.

-- 1. Branch coordinates (both set, or both empty).
alter table public.business_location
  add column if not exists latitude  numeric(9,6),
  add column if not exists longitude numeric(9,6);

alter table public.business_location drop constraint if exists business_location_coords_check;
alter table public.business_location
  add constraint business_location_coords_check check (
    (latitude is null) = (longitude is null)
    and (latitude  is null or latitude  between -90  and 90)
    and (longitude is null or longitude between -180 and 180)
  );

-- 2. Frozen on the reservation: the pin, the road distance, and the fee.
alter table public.reservations
  add column if not exists venue_latitude        numeric(9,6),
  add column if not exists venue_longitude       numeric(9,6),
  add column if not exists transport_distance_km numeric(7,2),
  add column if not exists transport_fee         numeric(12,2) not null default 0;

alter table public.reservations drop constraint if exists reservations_transport_check;
alter table public.reservations
  add constraint reservations_transport_check check (
    transport_fee >= 0
    and (transport_distance_km is null or transport_distance_km >= 0)
    and (venue_latitude  is null or venue_latitude  between -90  and 90)
    and (venue_longitude is null or venue_longitude between -180 and 180)
  );

comment on column public.reservations.transport_fee is
  'Offsite transport fee (₱) frozen at booking time; already included in total_price. 0 for onsite or when the fee was off.';
comment on column public.reservations.transport_distance_km is
  'Road distance (km) from the nearest branch to the venue pin used to price transport_fee, frozen at booking time.';
