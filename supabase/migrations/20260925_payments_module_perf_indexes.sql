-- Performance indexes for the admin Payments module (js/admin_payments.js),
-- next in the same audit series as 20260922_admin_dashboard_perf_indexes.sql
-- and 20260924_reservations_module_perf_indexes.sql.
--
-- Everything else this page touches is already covered:
--   - payment.payment_status / payment.reservation_id -> already indexed
--     (20260922)
--   - reservations.reservation_id, payment.payment_id,
--     reschedule_requests.reschedule_request_id,
--     reservation_extensions.extension_id, payment_method.payment_method_id
--     -> each is that table's own primary key, auto-indexed by Postgres
--
-- Two genuine gaps found:
--
-- 1. payment.submitted_at — js/admin_payments.js:656-681 fetchPayments()
--    fetches the ENTIRE payment table with no filter at all, ordered by
--    .order('submitted_at', { ascending: false }) — this is the main
--    payments review queue, loaded on every page visit. No index existed
--    on this column at all.
create index if not exists payment_submitted_at_idx
  on public.payment (submitted_at);

-- 2. receipts.payment_id — js/admin_payments.js:603-605
--    .from('receipts').in('payment_id', paymentIds), a fan-out from the
--    payments list to their receipts. Same provenance gap as
--    reschedule_requests (20260924's note applies here too): receipts was
--    "provisioned directly in the Supabase dashboard" per
--    20260727_fix_receipts_rls.sql's own comment, never created through a
--    tracked migration, so nothing here is guessing away an index that
--    might already exist under this exact name — grepping every migration
--    for "receipts" turns up RLS policies only, never CREATE INDEX.
--    payment_id is a plain FK column here (receipts has its own primary
--    key), not itself the primary key, so it needs its own index for the
--    .in() lookup.
create index if not exists receipts_payment_id_idx
  on public.receipts (payment_id);
