-- Per-event-type minimum booking notice override.
--
-- system_settings.reservation_rules.min_advance_days stays the site-wide
-- default (still the only thing the customer booking page's
-- loadReservationRules() in reservations.html reads) — this column lets a
-- specific event type require more (or less) notice than that default,
-- without introducing a second settings blob. NULL means "use the
-- site-wide default," matching the exact blank-means-default convention
-- already used for scope_capacity.capacity (see renderScopeCapacityTable in
-- js/super_admin_settings.js: `override ?? globalDefault`).
alter table public.event_types
  add column if not exists min_advance_days integer check (min_advance_days is null or min_advance_days >= 0);
