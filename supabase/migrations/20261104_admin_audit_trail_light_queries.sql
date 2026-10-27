-- 20261104_admin_audit_trail_light_queries.sql
--
-- Two small functions for the admin Audit Trail page (js/super_admin_audit.js)
-- that replace "download rows, count them in the browser" with a database
-- answer. The page itself already pages on the server; this removes the two
-- remaining bulk downloads.
--
-- Before:
--   * the four stat cards (Total Actions Today / Reservation Changes /
--     Payment Actions / Contract Actions) downloaded every audit row created
--     today, then counted them by category in the browser
--   * the Entities filter downloaded up to 1,000 audit rows just to find the
--     distinct category names
-- After: one tiny call each, returning only the numbers / the names.
--
-- Both are SECURITY INVOKER (same choice as the other admin page functions):
-- they run with the caller's own permissions, so row-level security on
-- audit_log applies exactly as it did for the old direct queries. They grant
-- no extra visibility.
--
-- Indexes already in place that these use (confirmed on the live table):
--   idx_audit_log_created_at, idx_audit_log_category

-- Counts of audit rows created at or after p_since (the browser passes the
-- start of the admin's local day, same as before).
create or replace function public.get_admin_audit_stats(p_since timestamptz)
returns jsonb
language sql
stable
security invoker
set search_path = public
as $$
  select jsonb_build_object(
    'total',       count(*),
    'reservation', count(*) filter (where category = 'reservation'),
    'payment',     count(*) filter (where category = 'payment'),
    'contract',    count(*) filter (where category = 'contract')
  )
  from public.audit_log
  where created_at >= p_since;
$$;

revoke all on function public.get_admin_audit_stats(timestamptz) from public, anon;
grant execute on function public.get_admin_audit_stats(timestamptz) to authenticated;

-- Distinct, non-empty category names, A-Z, for the Entities filter.
create or replace function public.get_admin_audit_categories()
returns jsonb
language sql
stable
security invoker
set search_path = public
as $$
  select coalesce(jsonb_agg(c.category order by c.category), '[]'::jsonb)
    from (
      select distinct category
        from public.audit_log
       where category is not null
         and category <> ''
    ) c;
$$;

revoke all on function public.get_admin_audit_categories() from public, anon;
grant execute on function public.get_admin_audit_categories() to authenticated;

-- Make the API pick up the new functions immediately.
notify pgrst, 'reload schema';
