-- Fix: "new row violates row-level security policy for table 'payment'"
-- when a manager approves a customer's cancellation request.
--
-- Root cause: the only tracked manager INSERT policy on public.payment
-- ("manager insert in-cafe payments", 20260725_payment_ledger.sql) is
-- scoped to the in-café recording shape only:
--   payment_source = 'in_cafe' AND payment_status = 'approved'
--   AND recorded_by = auth.uid()
--
-- The cancellation-fee insert (js/admin_reservation_details.js,
-- 'approve-cancellation' action) is a different shape entirely — it
-- creates a *pending* charge the customer still has to pay, with no
-- payment_source and no recorded_by:
--   payment_type = 'cancellation_fee', payment_status = 'pending_review'
--
-- That row satisfies neither the in-café policy above nor the untracked
-- customer-scoped insert policy (the manager isn't the reservation's
-- owner), so RLS has no policy to allow it. This is purely a missing
-- policy for a real, already-correctly-authenticated manager action — not
-- a wrong-identity insert (the client call runs under the manager's own
-- session) and not a legacy-table issue (public.payment is the one real
-- ledger; there is no separate reservation_payments table in this
-- project). The auto_cancel_overdue_reservations() DB function, which
-- inserts the same payment_type via a different path, is SECURITY
-- DEFINER and already bypasses RLS — untouched here.
--
-- Scoped narrowly (role + payment_type + payment_status) to match this
-- exact insert shape, mirroring how "manager insert in-cafe payments"
-- itself is scoped — not a blanket manager-insert-anything policy, and
-- grants nothing to customer or admin.

drop policy if exists "manager insert cancellation fee" on public.payment;
create policy "manager insert cancellation fee"
  on public.payment for insert
  with check (
    get_my_role() = 'manager'
    and payment_type = 'cancellation_fee'
    and payment_status = 'pending_review'
  );
