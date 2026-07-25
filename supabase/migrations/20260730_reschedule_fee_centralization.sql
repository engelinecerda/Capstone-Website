-- Reservation Form Configuration / Contract Template — Step 2.
--
-- reschedule_fee was a literal `3000` hardcoded in two places (js/account.js
-- and js/customer_payments.js, both via buildPaymentOption(..., 'reschedule_fee',
-- 3000, ...)) with no admin control and no single source of truth — unlike
-- cancellation_fee_onsite/offsite, which already live in this same
-- system_settings.payment_rules JSON row. Adding reschedule_fee alongside
-- them closes that gap and gives the contract template's {{reschedule_fee}}
-- token something real to resolve from.
--
-- Seeded at 3000 to preserve current behavior exactly — no visible change
-- until an admin edits it on the Payment Options "Payment Rules" panel.
-- ─────────────────────────────────────────────────────────────────────────────

update public.system_settings
set setting_value = jsonb_set(setting_value::jsonb, '{reschedule_fee}', '3000', true)::text
where setting_key = 'payment_rules';
