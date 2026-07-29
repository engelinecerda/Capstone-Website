-- Reservation Form configuration page: fixes a real RLS security gap on
-- event_types, and seeds the system_settings keys the new
-- admin/config/form.html page reads/writes.
--
-- Run manually in the Supabase SQL Editor per this project's convention.

-- ============================================================
-- 1. Fix event_types write access — was "any authenticated user"
-- ============================================================
-- The original policy (20260509_create_event_types.sql) checked only
-- auth.role() = 'authenticated', which lets ANY logged-in customer insert/
-- update/delete event types via a direct REST call, not just admin/manager.
-- Event types are system configuration (same category as package/
-- package_category/package_tier), so this mirrors the admin-exclusive
-- pattern already established for those in
-- 20260714_admin_manager_separation_of_duties.sql. The public read-active
-- policy is untouched — customers must still be able to read Active event
-- types to populate the booking form's dropdown.
DROP POLICY IF EXISTS "Admins can manage event types" ON public.event_types;
CREATE POLICY "Admin manage event types" ON public.event_types
  FOR ALL
  USING (get_my_role() = 'admin')
  WITH CHECK (get_my_role() = 'admin');

-- ============================================================
-- 2. Terms & Conditions / Data Privacy Policy — admin-editable text
-- ============================================================
-- Seeded with the exact text currently hardcoded in POLICY_CONTENT inside
-- reservations.html (kept in place there as a fallback — see
-- js/reservation_form_config.js, which only overrides that hardcoded copy
-- when a non-empty body is found here). Format: blank-line-separated
-- blocks; a short single line with no trailing period is treated as a
-- heading, lines starting with "- " render as a bullet list.
INSERT INTO public.system_settings (setting_key, setting_value)
VALUES (
  'terms_and_conditions',
  $body${"body":"1. Reservation Agreement\nBy submitting a reservation, the customer confirms that all provided information is accurate and agrees to comply with the policies stated in this system. A reservation is considered pending until reviewed and approved by the administrator.\n\n2. Package and Services\nThe selected package includes the agreed services such as catering setup, food and beverage inclusions, event setup, and assigned staff. Specific inclusions depend on the chosen package and are displayed during the reservation process.\nAdditional costs such as crew meals and transportation fees may apply depending on the event location and requirements.\n\n3. Payment Terms\nReservations may be confirmed through any of the following:\n- Full Payment\n- 50% Down Payment\n- Reservation Fee\nAny reservation fee paid will be deducted from the total package amount. The remaining balance must be settled before the specified payment deadline.\nAll submitted payments are subject to verification by the administrator. Customers must provide accurate payment details and valid proof of payment.\n\n4. Non-Refundable Policy\nAll payments made are strictly non-refundable. Once a payment is submitted and verified, it cannot be reversed or refunded under any circumstances.\n\n5. Rescheduling Policy\nCustomers may request to reschedule their reservation depending on availability. A rescheduling fee of P3,000 will be required. The requested date must be available and is subject to approval by the administrator.\n\n6. Cancellation Policy\nIn the event of cancellation, all payments made will remain non-refundable. Cancellation requests may still be recorded in the system for documentation and administrative purposes.\n\n7. Contract Submission\nCustomers are required to submit a signed contract as part of the reservation process. The system may allow resubmission of contracts if revisions are requested by the administrator. Submitted contracts are subject to review and approval.\n\n8. Electronic Transactions and Signatures\nThis system complies with Republic Act No. 8792, also known as the Electronic Commerce Act of 2000, which recognizes the legal validity of electronic data messages, electronic documents, and electronic signatures.\nAll electronic records, including reservation details, submitted contracts, and uploaded documents, are considered legally binding and equivalent to their paper-based counterparts.\nBy submitting a reservation and signing the contract electronically, the customer acknowledges and agrees that their electronic signature represents their identity and intent to enter into a binding agreement with ELI Coffee Events.\n\n9. System Usage\nBy using this system, the customer agrees not to provide false information, misuse the platform, or submit invalid or fraudulent payment records. The administrator reserves the right to reject, cancel, or take appropriate action on reservations that violate system policies.\n\n10. Data Privacy\nCustomer information such as name, contact details, and uploaded documents will be securely stored and used solely for reservation processing, communication, and administrative purposes in accordance with applicable data privacy regulations.\n\n11. Agreement\nBy checking the agreement box and submitting the reservation, the customer confirms that they have read, understood, and agreed to all the terms and conditions stated above."}$body$
)
ON CONFLICT (setting_key) DO NOTHING;

INSERT INTO public.system_settings (setting_key, setting_value)
VALUES (
  'data_privacy_policy',
  $body${"body":"Policy Statement\nELI Coffee Events is committed to protecting the privacy and personal data of its users in accordance with Republic Act No. 10173, also known as the Data Privacy Act of 2012.\n\n1. Collection of Personal Data\nThe system collects personal information such as name, email address, phone number, and other relevant details provided during account registration, reservation, and payment submission. Uploaded files such as proof of payment and signed contracts are also collected as part of the reservation process.\n\n2. Purpose of Data Collection\nPersonal data is collected and used solely for the following purposes:\n- Processing and managing reservations\n- Verifying payment submissions\n- Reviewing and validating contracts\n- Communicating with customers regarding their reservations\n- Maintaining records for administrative and operational purposes\n\n3. Data Storage and Security\nAll personal data and uploaded documents are securely stored using trusted third-party services. Reasonable organizational, physical, and technical security measures are implemented to protect data against unauthorized access, alteration, disclosure, or destruction.\n\n4. Data Sharing and Disclosure\nPersonal data will not be sold, shared, or disclosed to unauthorized third parties. Data may only be accessed by authorized personnel of ELI Coffee Events for operational and administrative purposes.\n\n5. Data Retention\nPersonal data will be retained only for as long as necessary to fulfill the purposes stated above or as required by applicable laws and regulations. Records related to reservations, payments, and contracts may be retained for documentation and audit purposes.\n\n6. User Rights\nUsers have the right to access, review, and request correction of their personal data stored in the system. Requests may be subject to verification and system limitations.\n\n7. Use of System\nBy using this system and submitting personal information, the user consents to the collection, use, and processing of their data in accordance with this policy.\n\n8. Contact and Inquiries\nFor any questions or concerns regarding data privacy, users may contact ELI Coffee Events through the provided contact channels.\n\n9. Policy Updates\nThis Data Privacy Policy may be updated from time to time. Continued use of the system constitutes acceptance of any changes made."}$body$
)
ON CONFLICT (setting_key) DO NOTHING;

-- ============================================================
-- 3. Required-field toggles for the booking form
-- ============================================================
-- Deliberately small: reservations.html is a tightly-coupled wizard where
-- most fields (package, guest count, date) drive pricing/validation and
-- can't be safely made optional from a settings toggle. Only the fields
-- that are genuinely optional-by-business-decision are configurable here.
INSERT INTO public.system_settings (setting_key, setting_value)
VALUES (
  'reservation_form_fields',
  '{"contact_phone_required": true, "special_requests_required": false}'
)
ON CONFLICT (setting_key) DO NOTHING;

NOTIFY pgrst, 'reload schema';
