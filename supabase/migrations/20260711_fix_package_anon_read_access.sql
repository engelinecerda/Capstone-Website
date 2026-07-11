-- 20260628_package_rls_and_grants.sql added a "Public read active
-- packages/categories/tiers" RLS policy so guests could browse the
-- reservation calendar without an account, but the GRANT statement in that
-- same migration only covered the `authenticated` role. Postgres checks
-- table-level GRANTs before RLS policies are evaluated, so anonymous
-- visitors got a permission-denied error on every package fetch. Packages
-- never loaded, so the reservation page could never determine a booking
-- scope, and every calendar date stayed disabled for anyone who wasn't
-- logged in.

GRANT SELECT ON public.package          TO anon;
GRANT SELECT ON public.package_category TO anon;
GRANT SELECT ON public.package_tier     TO anon;

-- calendar_blackouts has the same "customers read blackouts ... USING (true)"
-- policy intent (see supabase_setup.md Step 7) but was created by hand
-- through the SQL Editor, whose snippet never grants anon SELECT either.
-- A failed fetch here doesn't block date selection like the package grant
-- did, but it does mean closed dates silently stop showing as closed for
-- guests — same "visible to everyone" gap, so it's fixed here too.
GRANT SELECT ON public.calendar_blackouts TO anon;
