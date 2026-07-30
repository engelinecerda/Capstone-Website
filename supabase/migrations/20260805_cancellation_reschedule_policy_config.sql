-- Admin-configurable copy for the "Important Notice" blocks shown to
-- customers in account.html's Cancel Reservation and Reschedule Request
-- modals — mirrors the terms_and_conditions / data_privacy_policy pattern
-- from 20260729_reservation_form_config.sql exactly: seeded with the copy
-- that is currently hardcoded in account.html (kept there as the fallback),
-- same {"body": "..."} shape, same blank-line-block format parsed by
-- js/policy_text.js (already shared with the admin preview).
--
-- The reschedule fee itself was already admin-configurable (payment_rules.
-- reschedule_fee, see 20260722_payment_methods_and_rules.sql) — this only
-- adds the accompanying POLICY TEXT, which previously had no notice at all
-- shown to the customer before they submitted a reschedule request.
--
-- Run manually in the Supabase SQL Editor per this project's convention.

INSERT INTO public.system_settings (setting_key, setting_value)
VALUES (
  'cancellation_policy',
  $body${"body":"Non-Refundable Policy\nAll payments already made for this reservation are strictly non-refundable. Cancelling will not reverse any amounts previously submitted or verified."}$body$
)
ON CONFLICT (setting_key) DO NOTHING;

INSERT INTO public.system_settings (setting_key, setting_value)
VALUES (
  'reschedule_policy',
  $body${"body":"Rescheduling Policy\nRequests are subject to availability on the new date and time you select. Your original booking stays in place until an admin approves the request.\n\nA rescheduling fee applies once your request is approved, and must be paid to confirm the new date. This fee is separate from, and does not replace, any balance still owed on your reservation."}$body$
)
ON CONFLICT (setting_key) DO NOTHING;

NOTIFY pgrst, 'reload schema';
