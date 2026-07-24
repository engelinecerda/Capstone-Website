-- Fix: "new row for relation payment violates check constraint
-- payment_payment_type_check".
--
-- Root cause: same recurring gap as receipts and reservation_staff_
-- assignments (see 20260727_fix_receipts_rls.sql) — payment_payment_type_
-- check was provisioned directly in the Supabase dashboard and was never
-- captured in a migration, so nothing in this repo could keep it in sync
-- as new payment_type values were introduced in application code.
--
-- The app inserts six distinct payment_type values into public.payment:
--   - reservation_fee, down_payment, full_payment, partial_payment
--     (the four admin-configurable base types — see the payment_type
--     reference table added in 20260723_payment_types_and_method_delete.sql)
--   - reschedule_fee   (js/customer_payments.js, js/account.js)
--   - cancellation_fee (js/account.js, and the auto-cancel trigger in
--     20260716_payment_overhaul.sql)
-- The last two are penalty/change fees, not admin-configurable base
-- payment types, so they were never added to the payment_type reference
-- table above — but they still need to be valid values in this column.
-- Whatever list the dashboard-created constraint currently enforces is
-- missing at least one of these, hence the violation.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.payment DROP CONSTRAINT IF EXISTS payment_payment_type_check;

ALTER TABLE public.payment ADD CONSTRAINT payment_payment_type_check
  CHECK (payment_type IN (
    'reservation_fee',
    'down_payment',
    'full_payment',
    'partial_payment',
    'reschedule_fee',
    'cancellation_fee'
  ));
