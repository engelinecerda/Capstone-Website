-- 20261029_admin_nav_counts_rpc.sql
--
-- One call for everything the admin sidebar needs.
--
-- Every admin page load used to send six separate requests just to paint the
-- sidebar: pending reservations, pending payments, the ENTIRE
-- reservation_contracts table (counted in the browser), the admin's
-- reviews_last_seen_at, the unread-review count, and the maintenance-mode flag.
-- This function returns all five numbers/flags in a single request, with the
-- contract count done in SQL instead of downloading every contract row.
--
-- SECURITY INVOKER (the default, stated explicitly): the function runs with
-- the caller's own permissions, so row-level security applies exactly as it did
-- for the separate queries. It grants no extra visibility.
--
-- The counts match the logic that used to live in js/admin_sidebar_counts.js:
--   pending contracts = has a contract_url, no verified_date, and review_status
--                       is 'pending_review' or empty
--   unread reviews    = reviews newer than the caller's reviews_last_seen_at
--                       (all reviews when it has never been set)

create or replace function public.get_admin_nav_counts()
returns jsonb
language sql
stable
security invoker
set search_path = public
as $$
  select jsonb_build_object(
    'pending_reservations',
      (select count(*) from public.reservations where status = 'pending'),
    'pending_payments',
      (select count(*) from public.payment where payment_status = 'pending_review'),
    'pending_contracts',
      (select count(*)
         from public.reservation_contracts c
        where coalesce(c.contract_url, '') <> ''
          and c.verified_date is null
          and lower(coalesce(c.review_status, '')) in ('', 'pending_review')),
    'unread_reviews',
      (select count(*)
         from public.reviews r
        where r.created_at > coalesce(
          (select p.reviews_last_seen_at
             from public.profiles p
            where p.user_id = (select auth.uid())),
          '-infinity'::timestamptz)),
    'maintenance_on',
      coalesce((select m.is_on from public.maintenance_mode m where m.id = true), false)
  );
$$;

revoke all on function public.get_admin_nav_counts() from public, anon;
grant execute on function public.get_admin_nav_counts() to authenticated;

-- Small partial indexes so the two "pending" counts stay cheap as the tables grow.
create index if not exists reservations_pending_status_idx
  on public.reservations (status)
  where status = 'pending';

create index if not exists payment_pending_review_idx
  on public.payment (payment_status)
  where payment_status = 'pending_review';
