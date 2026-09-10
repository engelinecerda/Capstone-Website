-- Replaces js/admin_customers.js's fetchReservationActivity(), which
-- fetched the ENTIRE reservations table (every row, every column it
-- selected) on every Customers page load just to compute three numbers
-- per customer in JS (mergeCustomersWithActivity): total reservation
-- count, approved-reservation count, and the most recent reservation
-- date. That's a pure per-user_id aggregate — exactly what the database
-- should compute, same reasoning as
-- 20260923_admin_dashboard_stats_rpc.sql for the Dashboard.
--
-- Returns one row per customer who has at least one reservation (a
-- customer with zero reservations simply has no row here — the same
-- "?? 0" defaulting js/admin_customers.js's mergeCustomersWithActivity
-- already does covers that, same as today).
--
-- language sql + returns table matches this project's existing
-- get_package_booking_counts() (20260906_package_booking_counts_rpc.sql)
-- rather than the JSONB-blob shape used for the Dashboard RPC — that one
-- needed a single heterogeneous result (totals + a nested monthly array);
-- this one is a plain per-id list, and supabase-js already returns a
-- `returns table` result as a JSON array of rows, which is exactly the
-- shape mergeCustomersWithActivity wants to key a Map by user_id from.
-- reservations.user_id had no index at all (checked every migration —
-- zero CREATE INDEX hits on it). The RPC below groups by it over the
-- whole table with no WHERE clause, which an index doesn't remove the
-- need to visit every row for, but it does let Postgres group via an
-- ordered index scan instead of a full hash-aggregate — and this column
-- is the standard "this customer's reservations" lookup shape used
-- elsewhere in the app too, so it's broadly useful, not single-purpose.
create index if not exists reservations_user_id_idx
  on public.reservations (user_id);

create or replace function public.get_customer_reservation_activity()
returns table(
  user_id uuid,
  total_reservations integer,
  approved_reservations integer,
  last_reservation_date timestamptz
)
language sql
stable
security definer
set search_path = public
as $$
  select
    r.user_id,
    count(*)::integer as total_reservations,
    count(*) filter (where lower(r.status) in ('approved', 'confirmed'))::integer as approved_reservations,
    max(r.created_at) as last_reservation_date
  from public.reservations r
  where r.user_id is not null
  group by r.user_id;
$$;

grant execute on function public.get_customer_reservation_activity() to authenticated;
