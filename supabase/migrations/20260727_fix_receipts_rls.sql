-- Fix: "new row violates row-level security policy for table receipts"
-- when a Manager approves a cash/card payment.
--
-- Root cause: same recurring gap as payment and reservation_contracts (see
-- 20260713_fix_payment_rls.sql) — the `receipts` table was provisioned
-- directly in the Supabase dashboard with RLS enabled but no policy ever
-- captured in migrations. With no matching INSERT policy, Postgres denies
-- by default, which is exactly the error surfaced by
-- ensureReceiptForPayment() in js/admin_record_payment.js — called both
-- when a Manager approves an online payment (js/admin_payments.js) and
-- when a Manager records an in-café cash/card payment.
--
-- Receipts are payment-operational data, so Manager gets full read/write
-- (mirroring payment's separation-of-duties model:
-- 20260714_admin_manager_separation_of_duties.sql); Admin keeps read-only
-- visibility; customers can read receipts for their own reservation's
-- payments (receipts has no direct user_id column, so ownership is proven
-- via payment -> reservations, same join pattern as
-- "customer read own payments" on the payment table).
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.receipts ENABLE ROW LEVEL SECURITY;

-- ── Manager/Admin can read all receipts ──────────────────────────────────────
DROP POLICY IF EXISTS "admin read all receipts" ON public.receipts;
CREATE POLICY "admin read all receipts"
  ON public.receipts FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.user_id = auth.uid()
        AND p.role IN ('manager', 'admin')
    )
  );

-- ── Customers can read receipts for their own reservation's payments ────────
DROP POLICY IF EXISTS "customer read own receipts" ON public.receipts;
CREATE POLICY "customer read own receipts"
  ON public.receipts FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.payment pay
      JOIN public.reservations r ON r.reservation_id = pay.reservation_id
      WHERE pay.payment_id = receipts.payment_id
        AND r.user_id = auth.uid()
    )
  );

-- ── Manager can create receipts (approve payment / record in-café payment) ──
DROP POLICY IF EXISTS "manager manage receipts" ON public.receipts;
CREATE POLICY "manager manage receipts"
  ON public.receipts FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.user_id = auth.uid()
        AND p.role = 'manager'
    )
  );

NOTIFY pgrst, 'reload schema';
