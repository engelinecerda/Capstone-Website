-- Disk-IO reduction for the forecast pipeline (python/forecast.py and the
-- /forecast endpoint in python/main.py both run the exact same query:
-- .from('reservations').select('event_date').eq('status', 'completed'),
-- with NO limit/range). Today that pulls every completed reservation row
-- off disk and across the wire, just so pandas can immediately collapse
-- it down to one row per month in run_forecast(). As the reservations
-- table grows, this query's cost grows with total completed-reservation
-- count even though the actual output Prophet needs is a handful of
-- monthly totals — exactly the kind of full-table read the project's
-- Disk IO Budget warning (20260830_disk_io_cleanup.sql) flagged before.
--
-- Two changes, same pattern as the other *_perf_indexes.sql /
-- *_rpc.sql migrations in this repo:
--
-- 1. A partial index on reservations(event_date) WHERE status =
--    'completed'. Scoped to just the rows this query ever touches (a
--    fraction of the full table once cancelled/pending/declined rows are
--    excluded), and it carries event_date as its key so a query that only
--    needs event_date for completed rows can be satisfied as an
--    index-only scan instead of an index scan + heap fetch per row.
--    reservations.status is already indexed (20260922_admin_dashboard_
--    perf_indexes.sql) for the sidebar's .eq('status','pending') count,
--    but that index doesn't carry event_date and isn't scoped to
--    'completed', so it can't serve this query as an index-only scan.
--
-- 2. get_monthly_completed_reservation_counts(): does the GROUP BY month
--    in Postgres and returns one row per month instead of one row per
--    reservation. forecast.py's df.groupby(df['ds'].dt.to_period('M'))
--    becomes unnecessary — the database already returns exactly that
--    shape. security definer isn't needed here (both call sites use the
--    service_role key, which bypasses RLS already), so this is left
--    security invoker and ungranted beyond the default service_role
--    access, unlike the authenticated-facing RPCs elsewhere in this repo.
create index if not exists reservations_completed_event_date_idx
  on public.reservations (event_date)
  where status = 'completed';

create or replace function public.get_monthly_completed_reservation_counts()
returns table (month date, reservation_count bigint)
language sql
stable
set search_path = public
as $$
  select
    date_trunc('month', event_date)::date as month,
    count(*) as reservation_count
  from public.reservations
  where status = 'completed'
  group by 1
  order by 1;
$$;

-- Verify with (run as separate queries):
--   explain (analyze, buffers) select event_date from public.reservations where status = 'completed';
--   select * from public.get_monthly_completed_reservation_counts();
