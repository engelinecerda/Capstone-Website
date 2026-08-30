-- Two independent findings from the same investigation:
--
-- 1. Confirmed live: public.reservations is readable by a fully
--    unauthenticated request (the public anon key alone, no user session)
--    — reservation_id, user_id, event_type, event_date, status all came
--    back for rows belonging to multiple different customers. RLS policies
--    for this table already exist correctly in
--    20260418_fix_reservations_rls_access.sql ("select own reservations":
--    auth.uid() = user_id; admin/manager read-all; staff display-eligible),
--    but the live table is not enforcing them — most likely that migration
--    was never actually run against this Supabase project (migrations here
--    are applied manually), or RLS was toggled off outside of a tracked
--    migration. This statement is idempotent either way: it re-asserts RLS
--    is on and strips any blanket anon privilege regardless of which of
--    those happened.
alter table public.reservations enable row level security;
revoke select on public.reservations from anon;

-- 2. Supabase database linter flag (0010_security_definer_view): the
-- reservation_payment_summary view (20260725_payment_ledger.sql) was
-- created without security_invoker, so by default it runs with the view
-- owner's privileges rather than the querying user's for RLS purposes.
-- It's already scoped to `authenticated` only (never granted to anon), but
-- without security_invoker a logged-in customer querying it could
-- potentially see another customer's payment summary rather than being
-- correctly filtered to their own reservation via the RLS on the
-- underlying reservations/payment tables. Requires Postgres 15+
-- (Supabase-hosted Postgres already is).
alter view public.reservation_payment_summary set (security_invoker = true);
