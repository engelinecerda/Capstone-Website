-- Materializes the package-category distribution chart
-- (python/main.py's GET /analytics/package-distribution) on a schedule,
-- instead of recomputing it — unfiltered, from every row of
-- `reservations` — on every single dashboard load.
--
-- Why materializing rather than just moving the count into SQL: the
-- underlying query has no WHERE clause at all — it summarizes every
-- reservation that has ever existed — so a plain SQL-side GROUP BY
-- still has to read every row on every call. That removes the wasted
-- per-row join/JSON work Python was doing (see the endpoint's old body),
-- but not the disk IO of reading the whole table. reservations.package_id
-- also has no index, and one wouldn't meaningfully help here anyway — an
-- index pays off reading a *subset* of a table, not summarizing all of
-- it. Recomputing this only every 30 minutes via pg_cron — the same
-- cadence already used for cleanup-cron-job-run-details
-- (20260830_disk_io_cleanup.sql) — turns "full table scan on every
-- dashboard open" into "full table scan once every 30 minutes,"
-- regardless of how many people have the dashboard open or how often
-- auto_refresh.js polls it.
--
-- Trade-off, same shape as the completed-status cron lag already
-- accepted elsewhere in this project (20260930b_auto_complete_past_
-- reservations.sql): the chart can be up to ~30 minutes stale.

create table if not exists public.package_category_distribution_cache (
  category_name     text primary key,
  reservation_count bigint not null default 0,
  refreshed_at      timestamptz not null default now()
);

alter table public.package_category_distribution_cache enable row level security;

drop policy if exists "Staff can read package category distribution cache"
  on public.package_category_distribution_cache;
create policy "Staff can read package category distribution cache"
  on public.package_category_distribution_cache
  for select
  to authenticated
  using (true);

-- Recomputes the cache table from scratch. SECURITY DEFINER: pg_cron
-- runs this as the role that scheduled it, and it needs to read the full
-- reservations table regardless of that role's own RLS grants — same
-- reasoning as complete_past_reservations() (20260930b).
create or replace function public.refresh_package_category_distribution()
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  delete from public.package_category_distribution_cache;

  insert into public.package_category_distribution_cache (category_name, reservation_count, refreshed_at)
  select
    coalesce(pc.category_name, 'Unknown'),
    count(*),
    now()
  from public.reservations r
  left join public.package p on p.package_id = r.package_id
  left join public.package_category pc on pc.package_category_id = p.package_category_id
  group by 1;
end;
$$;

grant execute on function public.refresh_package_category_distribution() to authenticated;

-- Populate it immediately so the cache isn't empty until the first cron tick.
select public.refresh_package_category_distribution();

select cron.unschedule(jobid) from cron.job where jobname = 'refresh-package-category-distribution';
select cron.schedule(
  'refresh-package-category-distribution',
  '*/30 * * * *',
  $$select public.refresh_package_category_distribution();$$
);

-- Verify with (run as separate queries):
--   select * from public.package_category_distribution_cache order by reservation_count desc;
--   select * from cron.job where jobname = 'refresh-package-category-distribution';
--   select * from cron.job_run_details
--     where jobid = (select jobid from cron.job where jobname = 'refresh-package-category-distribution')
--     order by start_time desc limit 5;
