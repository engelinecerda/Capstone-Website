-- Fix: Manager-side Payments page shows no rows.
--
-- Root cause: same pattern as reservation_contracts (see
-- 20260713_fix_reservation_contracts_rls.sql) — the `payment` table has no
-- RLS policy tracked anywhere in migrations or archive, not even a stale
-- one. It was provisioned entirely outside version control. With RLS
-- enabled and no SELECT policy, Postgres silently returns zero rows to
-- every non-service-role client (no error), which is why
-- js/admin_payments.js's `fetchPayments()` query always comes back empty
-- and the page renders no rows.
--
-- Customer payment submission (INSERT) already works today — the
-- `notify_admins_on_new_payment` trigger fires on INSERT into `payment` —
-- so whatever write-side access already exists is left untouched. This
-- migration only adds the missing read access, plus a Manager UPDATE
-- policy (needed to approve/reject payments) mirroring the same gap found
-- and fixed on reservation_contracts.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.payment ENABLE ROW LEVEL SECURITY;

-- ── Manager/Admin can read all payment rows ──────────────────────────────────
DROP POLICY IF EXISTS "admin read all payments" ON public.payment;
CREATE POLICY "admin read all payments"
  ON public.payment FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.user_id = auth.uid()
        AND p.role IN ('manager', 'admin')
    )
  );

-- ── Customers can read their own reservation's payment rows ─────────────────
DROP POLICY IF EXISTS "customer read own payments" ON public.payment;
CREATE POLICY "customer read own payments"
  ON public.payment FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.reservations r
      WHERE r.reservation_id = payment.reservation_id
        AND r.user_id = auth.uid()
    )
  );

-- ── Manager can approve/reject payments ──────────────────────────────────────
DROP POLICY IF EXISTS "admin update payments" ON public.payment;
CREATE POLICY "admin update payments"
  ON public.payment FOR UPDATE
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
