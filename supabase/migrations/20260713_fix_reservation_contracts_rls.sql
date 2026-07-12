-- Fix: Manager-side Contracts page shows no contracts.
--
-- Root cause: `reservation_contracts` has row level security enabled
-- (archive/contract_resubmission_setup.sql) but was only ever given UPDATE
-- policies — there is no SELECT policy at all. With RLS on and no SELECT
-- policy, Postgres denies every SELECT for non-service-role clients, so
-- js/admin_contracts.js's query against this table always returns zero rows
-- (no error — RLS just filters silently), which makes every reservation
-- look like it has no contract and the page renders empty.
--
-- Secondary bug: the one UPDATE policy that does exist still checks the
-- pre-rename role value 'admin'. After 20260624_rename_roles_admin_to_manager.sql,
-- 'admin' means the system Admin role (formerly super_admin) — the Manager
-- role is now 'manager'. So that policy has been silently blocking Managers
-- from approving/requesting resubmission on contracts too.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.reservation_contracts ENABLE ROW LEVEL SECURITY;

-- ── Manager/Admin can read all contract rows ─────────────────────────────────
DROP POLICY IF EXISTS "admin read all reservation contracts" ON public.reservation_contracts;
CREATE POLICY "admin read all reservation contracts"
  ON public.reservation_contracts FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.user_id = auth.uid()
        AND p.role IN ('manager', 'admin')
    )
  );

-- ── Customers can read their own reservation's contract row ─────────────────
DROP POLICY IF EXISTS "customer read own reservation contracts" ON public.reservation_contracts;
CREATE POLICY "customer read own reservation contracts"
  ON public.reservation_contracts FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.reservations r
      WHERE r.reservation_id = reservation_contracts.reservation_id
        AND r.user_id = auth.uid()
    )
  );

-- ── Fix stale UPDATE policy (was checking pre-rename role value 'admin') ────
DROP POLICY IF EXISTS "admin update reservation contracts" ON public.reservation_contracts;
CREATE POLICY "admin update reservation contracts"
  ON public.reservation_contracts FOR UPDATE
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.user_id = auth.uid()
        AND p.role = 'manager'
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.user_id = auth.uid()
        AND p.role = 'manager'
    )
  );
