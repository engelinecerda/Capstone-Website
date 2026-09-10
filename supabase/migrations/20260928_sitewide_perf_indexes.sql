-- Follow-up performance pass, this time across the WHOLE codebase (not
-- just the 5 admin modules from the original audit) — every .from()/.eq()/
-- .in()/.order()/.gte()/.lte() call across all 84 files in js/ was
-- cross-referenced against the database's actual live index list (via
-- `npx supabase inspect db index-stats`, not just grepping migration
-- files — several tables here were "provisioned directly in the
-- dashboard" per earlier migrations' own comments, so tracked .sql files
-- alone would have under-reported what's already indexed and produced
-- false positives).
--
-- Most of what this pass found is ALREADY covered — the customer-facing
-- files (account.js, customer_payments.js, reservation_details.js,
-- reviews.js, board.js, etc.) all reuse the same payment/reservation_id/
-- reschedule_requests/reservation_extensions patterns the 5-module audit
-- already indexed, so they benefit from that work for free. These are
-- the only genuinely NEW gaps found:

-- 1. package_photo.package_id — js/reservations.js, js/package_details.js,
--    js/packages.js all fan out to this table with .in('package_id', ids)
--    or .eq('package_id', id).order('sort_order'). The only existing index
--    on this column, one_cover_per_package, is a PARTIAL unique index
--    (`where is_cover`) — it only covers the single cover-photo row per
--    package, not the general "all photos for this package" fetch these
--    three files actually run.
create index if not exists package_photo_package_id_idx
  on public.package_photo (package_id);

-- 2. reservations(user_id, created_at) — js/account.js:1879-1882's "my
--    reservations" query (.eq('user_id', ...).order('created_at')) is
--    about as hot a customer-facing query as this app has — every logged-
--    in customer hits it on every visit to their account page. user_id and
--    created_at are each already indexed separately (20260922/20260927),
--    but as two single-column indexes rather than one composite, Postgres
--    still needs a separate sort step after the user_id lookup. Given this
--    is exactly the table beta testing will grow the most, worth the
--    small extra write cost for the one query that runs most often.
create index if not exists reservations_user_id_created_at_idx
  on public.reservations (user_id, created_at);

-- 3. reservations(user_id, event_date) — js/reviews.js:270-280's "which of
--    my reservations can I review" query, same shape as #2 but sorted by
--    event_date instead of created_at (a genuinely different access
--    pattern, not redundant with it).
create index if not exists reservations_user_id_event_date_idx
  on public.reservations (user_id, event_date);

-- 4. reservation_extensions(reservation_id, requested_at) — js/customer_
--    payments.js:1005-1019 does .in('reservation_id', ids).order(
--    'requested_at'), the exact same shape as reschedule_requests'
--    already-fixed case (20260924). reservation_extensions_reservation_id_
--    idx exists but is single-column, so the ORDER BY still needs a
--    separate sort; low urgency today (2 rows) but this table scales
--    directly with how many customers request extensions during beta.
create index if not exists reservation_extensions_reservation_id_requested_at_idx
  on public.reservation_extensions (reservation_id, requested_at);

-- 5. reservation_staff_assignments.roster_staff_id — js/admin_staff_
--    roster.js:291-293 does .eq('roster_staff_id', id) with no
--    reservation_id filter alongside it. The two existing constraints on
--    this table (reservation_staff_assignments_reservation_id_staff_
--    user_id_key, ..._reservation_roster_unique) both have reservation_id
--    as the LEADING column — a composite index's trailing column gets no
--    benefit from a lookup that only filters on it, so this exact query
--    has never actually been covered.
create index if not exists reservation_staff_assignments_roster_staff_id_idx
  on public.reservation_staff_assignments (roster_staff_id);
