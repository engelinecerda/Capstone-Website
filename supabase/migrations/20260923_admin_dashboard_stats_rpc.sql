-- Replaces js/admin_homepage.js's pattern of fetching the ENTIRE
-- reservations table on every dashboard load just to compute status
-- totals, trend deltas, the customer count, and the monthly submitted/
-- completed chart in JavaScript. All of that is a pure aggregate over the
-- whole table — exactly what the database should compute, not the
-- browser. The dashboard's actual reservations TABLE (top 10 rows) stays
-- a normal bounded row-level query; only the stats/chart aggregation
-- moves here.
--
-- Timezone is fixed to Asia/Manila for "today"/"this month" boundaries —
-- the business operates in the Philippines (see the forecast cron's own
-- PH-timezone handling). This is actually more correct than the JS it
-- replaces, which used the viewing admin's own browser clock — two admins
-- in different timezones would previously see different "today" cutoffs
-- for the exact same data.
--
-- Same security posture as get_package_booking_counts() (see
-- 20260906_package_booking_counts_rpc.sql): SECURITY DEFINER because an
-- admin/manager client can't read the full reservations table directly
-- for this, but everything returned here is an aggregate count/total —
-- never a reservation row, customer name, or contact detail — so granting
-- execute to any authenticated user carries the same low exposure as that
-- precedent, even though only admin pages actually call it.
create or replace function public.get_admin_dashboard_stats()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  with bounds as (
    select
      (now() at time zone 'Asia/Manila')::date as today,
      date_trunc('month', now() at time zone 'Asia/Manila')::date as month_start
  ),
  status_counts as (
    select
      count(*) filter (where lower(status) = 'pending')                  as pending,
      count(*) filter (where lower(status) in ('confirmed', 'approved')) as approved,
      count(*) filter (where lower(status) = 'declined')                 as declined,
      count(*) filter (where lower(status) = 'completed')                as completed,
      count(*) filter (where lower(status) = 'cancelled')                as cancelled,
      count(*) filter (where lower(status) = 'rescheduled')              as rescheduled,
      count(*)                                                            as total,
      count(distinct user_id)                                             as total_customers,
      count(*) filter (
        where lower(status) = 'pending'
          and (created_at at time zone 'Asia/Manila')::date = (select today from bounds)
      ) as pending_today,
      count(*) filter (
        where lower(status) in ('confirmed', 'approved')
          and date_trunc('month', created_at at time zone 'Asia/Manila')::date = (select month_start from bounds)
      ) as approved_this_month,
      count(*) filter (
        where lower(status) = 'completed'
          and date_trunc('month', event_date)::date = (select month_start from bounds)
      ) as completed_this_month
    from public.reservations
  ),
  -- "New customer this month" = a customer whose EARLIEST reservation
  -- (by created_at) falls in the current month — matches the exact
  -- semantics of the old firstSeenByCustomer Map in js/admin_homepage.js.
  first_by_customer as (
    select user_id, min(created_at) as first_created_at
    from public.reservations
    where user_id is not null
    group by user_id
  ),
  new_customers as (
    select count(*) as new_customers_this_month
    from first_by_customer
    where date_trunc('month', first_created_at at time zone 'Asia/Manila')::date = (select month_start from bounds)
  ),
  -- Submitted (by created_at) and completed (by event_date) are counted
  -- from two independent GROUP BYs, same as the old computeMonthlyBreakdown
  -- did in two separate passes over the reservations array, then merged
  -- by (year, month) — a reservation submitted in one month and completed
  -- in another correctly contributes to both buckets.
  monthly as (
    select
      extract(year from created_at at time zone 'Asia/Manila')::int as year,
      (extract(month from created_at at time zone 'Asia/Manila')::int - 1) as month,
      count(*) as submitted,
      0::bigint as completed
    from public.reservations
    group by 1, 2
    union all
    select
      extract(year from event_date)::int as year,
      (extract(month from event_date)::int - 1) as month,
      0::bigint as submitted,
      count(*) as completed
    from public.reservations
    where lower(status) = 'completed'
    group by 1, 2
  ),
  monthly_merged as (
    select year, month, sum(submitted)::int as submitted, sum(completed)::int as completed
    from monthly
    group by year, month
    order by year, month
  )
  select jsonb_build_object(
    'status_counts', (select to_jsonb(status_counts) from status_counts),
    'new_customers_this_month', (select new_customers_this_month from new_customers),
    'monthly_breakdown', (select coalesce(jsonb_agg(to_jsonb(monthly_merged)), '[]'::jsonb) from monthly_merged)
  );
$$;

grant execute on function public.get_admin_dashboard_stats() to authenticated;
