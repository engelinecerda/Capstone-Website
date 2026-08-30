-- payment_payment_method_check never allowed 'bank' as a value — it was
-- created directly on the live database (not tracked in any prior
-- migration; confirmed via pg_get_constraintdef, current definition below)
-- back when 'bank' only ever appeared in display-label maps for backfilled/
-- historical rows, never as a value actually written at INSERT time.
--
-- 20260901_bank_transfer_generic_reference.sql's client-side fix
-- (resolveLegacyModeKey() in js/customer_payments.js no longer matches the
-- "BPI" label to key 'bpi'; a Bank Transfer row now resolves to its DB
-- `type`, 'bank') means every NEW Bank Transfer submission now tries to
-- insert payment_method = 'bank' — which this constraint has always
-- rejected. Adding it, changing nothing else already permitted (including
-- 'bpi', kept for the same superset/backward-compatibility reasoning as
-- the trigger fix in the same migration).
--
-- Original definition (for the record, since this constraint's history
-- lives nowhere else in the migrations folder):
--   CHECK ((payment_method = ANY (ARRAY['gcash'::text, 'maya'::text,
--   'bpi'::text, 'card'::text, 'cash'::text])))
-- ─────────────────────────────────────────────────────────────────────────────

alter table public.payment drop constraint if exists payment_payment_method_check;

alter table public.payment add constraint payment_payment_method_check
  check (payment_method = any (array['gcash'::text, 'maya'::text, 'bpi'::text, 'bank'::text, 'card'::text, 'cash'::text]));
