-- Performance indexes for the admin/management portal's data-fetching
-- hot paths. Confirmed against the actual queries in the app (not
-- speculative) — see file:line references below for each one. Purely
-- additive: no table/column/data changes, safe to run any time.
--
-- Audit that found these (ranked by how many admin pages/how often they
-- run): every list page (Dashboard, Reservations, Payments, Customers,
-- Reports) currently fetches its base table with no .range()/.limit() and
-- filters/sorts in JS — reducing THAT is a separate, larger follow-up.
-- These indexes at least remove the sequential-scan cost underneath those
-- fetches today, and set up for the bounded-query follow-up to actually
-- use an index instead of a full scan once it lands.
--
-- reservation_contracts.reservation_id is deliberately NOT indexed here —
-- it already has a unique index from the `reservation_contracts_
-- reservation_id_key` UNIQUE constraint added in
-- 20260824_fix_contract_resubmission_immutability.sql, so a second index
-- on the same single column would be pure write overhead with no read
-- benefit.

-- js/admin_sidebar_counts.js:24 — fetchPendingReservationCount():
-- .from('reservations').eq('status', 'pending'), count-only, runs on
-- every admin page load (sidebar badge).
create index if not exists reservations_status_idx
  on public.reservations (status);

-- js/admin_reservations.js:594, js/admin_homepage.js, js/admin_reports.js
-- — .order('created_at', { ascending: false }) on the full reservations
-- fetch each of those pages does on load.
create index if not exists reservations_created_at_idx
  on public.reservations (created_at);

-- js/admin_sidebar_counts.js:34 — fetchPendingPaymentCount():
-- .from('payment').eq('payment_status', 'pending_review'), count-only,
-- also runs on every admin page load. Also filtered elsewhere in
-- js/admin_payments.js's review queue.
create index if not exists payment_payment_status_idx
  on public.payment (payment_status);

-- payment.reservation_id is a foreign-key-shaped column with no index of
-- its own (Postgres does not auto-index FK columns) — hit by every
-- .in(reservationIds) fan-out from a reservations list to its payments,
-- in js/admin_reservations.js, js/admin_homepage.js, js/admin_payments.js.
create index if not exists payment_reservation_id_idx
  on public.payment (reservation_id);

-- js/admin_customers.js:254-255 — .eq('role', 'customer')
-- .order('date_registered', { ascending: false }) on the Customers page's
-- full profiles fetch.
create index if not exists profiles_role_idx
  on public.profiles (role);
