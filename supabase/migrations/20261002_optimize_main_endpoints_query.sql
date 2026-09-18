-- Extends 20261001_forecast_query_perf.sql to cover two endpoints in
-- python/main.py that run the same shape of full, unbounded reservations
-- fetch that forecast.py used to run — except these are hit on every
-- dashboard/report load, not once a day by cron, so they were actually
-- the bigger Disk IO Budget risk (see 20260830_disk_io_cleanup.sql):
--
--   fetch_actuals() in GET /forecast:
--     .select('event_date').eq('status', 'completed')          -- identical
--                                                                  to forecast.py's old query
--
--   GET /analytics/monthly-reservations:
--     .select('event_date').in_('status', ['approved','confirmed','completed'])
--
-- The second query's status list is a superset of the first's. Postgres
-- can satisfy `status = 'completed'` from a partial index scoped to
-- `status IN ('approved','confirmed','completed')`, because the narrower
-- predicate implies the broader one — so ONE partial index serves both
-- queries. That means the narrower, single-status index from
-- 20261001 is now redundant (every row it indexes is also indexed by the
-- broader one below), so it's dropped rather than left in place: keeping
-- both would mean paying the write-amplification/storage cost of two
-- overlapping partial indexes on every reservation insert/update for no
-- extra read benefit.
drop index if exists public.reservations_completed_event_date_idx;

create index if not exists reservations_active_event_date_idx
  on public.reservations (event_date)
  where status in ('approved', 'confirmed', 'completed');

-- Generalizes get_monthly_completed_reservation_counts() (20261001) to
-- take the status list as a parameter, so the same GROUP-BY-month logic
-- serves the analytics chart's 3-status aggregation too, instead of
-- duplicating that SQL in a second near-identical function.
-- get_monthly_completed_reservation_counts() is left in place unchanged
-- for forecast.py and fetch_actuals() — both call sites already work and
-- now benefit from the broader index above via the same predicate
-- implication, so there's no need to touch that code again.
create or replace function public.get_monthly_reservation_counts(p_statuses text[])
returns table (month date, reservation_count bigint)
language sql
stable
set search_path = public
as $$
  select
    date_trunc('month', event_date)::date as month,
    count(*) as reservation_count
  from public.reservations
  where status = any(p_statuses)
  group by 1
  order by 1;
$$;

-- Verify with (run as separate queries):
--   explain (analyze, buffers)
--     select event_date from public.reservations where status = 'completed';
--   explain (analyze, buffers)
--     select event_date from public.reservations
--     where status in ('approved','confirmed','completed');
--   select * from public.get_monthly_reservation_counts(array['approved','confirmed','completed']);
