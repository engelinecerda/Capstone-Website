-- Performance index for the admin Customers module (js/admin_customers.js),
-- next in the same audit series as 20260922/20260924/20260925.
--
-- js/admin_customers.js:241-255 fetchProfiles() — the customers list —
-- does .eq('role', 'customer').order('date_registered', { ascending: false }).
-- 20260922_admin_dashboard_perf_indexes.sql already added a plain index on
-- profiles.role (for a different page's .eq('role','customer') count-only
-- query), but that alone doesn't help this ORDER BY. A composite index
-- with role leading serves this page's exact filter+sort in one index scan
-- instead of a filter then a separate sort step, while still covering the
-- plain role-only lookups other pages already rely on (a composite
-- index's leading column works for a lookup on that column alone too, so
-- nothing regresses).
create index if not exists profiles_role_date_registered_idx
  on public.profiles (role, date_registered);

-- NOT indexed here, on purpose: js/admin_customers.js:264-279
-- fetchReservationActivity() fetches the ENTIRE reservations table with NO
-- filter at all — every row, every time, just to tally per-customer
-- reservation counts in JS. There is no WHERE clause for an index to
-- speed up; this one needs the same treatment Dashboard got
-- (20260923_admin_dashboard_stats_rpc.sql) — a database-side aggregate
-- (e.g. reservation counts grouped by user_id) — not an index. Flagging
-- rather than silently skipping it.
