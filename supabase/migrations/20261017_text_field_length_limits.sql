-- Server-side length limits on free-text columns an authenticated user
-- (customer, staff, manager, or admin) can write to directly.
--
-- Every one of these fields already got a matching `maxlength` on its
-- input/textarea (reservations.html, account.html, inquiry.html, the
-- admin Users & Roles / Business Profile / Page Content / Reservation
-- Form / Payment Settings / Referral Sources pages, etc.) — but maxlength
-- is a browser-only convenience. A request built directly against the
-- Supabase REST API (bypassing the page's own JS entirely) is not bound
-- by it, so the real "can someone actually store unbounded text" question
-- can only be answered at the database. This migration adds that layer
-- for the fields most directly exposed to that — confirmed by testing:
-- profiles.first_name/middle_name/last_name/staff_role had no limit at
-- either layer, so the Users & Roles "Invite/Edit" form (and any direct
-- API call) could persist arbitrarily long values with nothing to stop
-- it. The others here are the same category of gap on tables added or
-- touched this session (inquiries, referral_sources, business_social_link).
--
-- `not valid` on every constraint: it's enforced for every INSERT/UPDATE
-- from this point on, but does NOT retroactively validate existing rows —
-- if a row already exceeds the new limit, this migration still applies
-- cleanly instead of failing outright on data no one has visibility into
-- from the codebase alone. Run `alter table ... validate constraint ...`
-- later (once existing data is confirmed to fit) to close that gap too.
--
-- Limits are generous on purpose — wide enough that no legitimate name,
-- label, or note is ever truncated, tight enough that megabytes of spam
-- text can't be stored in a single field.

alter table public.profiles
  add constraint profiles_first_name_length check (char_length(first_name) <= 100) not valid,
  add constraint profiles_middle_name_length check (middle_name is null or char_length(middle_name) <= 100) not valid,
  add constraint profiles_last_name_length check (char_length(last_name) <= 100) not valid,
  add constraint profiles_staff_role_length check (staff_role is null or char_length(staff_role) <= 60) not valid;

alter table public.inquiries
  add constraint inquiries_full_name_length check (char_length(full_name) <= 150) not valid,
  add constraint inquiries_email_length check (char_length(email) <= 254) not valid,
  add constraint inquiries_mobile_number_length check (mobile_number is null or char_length(mobile_number) <= 30) not valid,
  add constraint inquiries_remarks_length check (remarks is null or char_length(remarks) <= 1000) not valid;

alter table public.referral_sources
  add constraint referral_sources_label_length check (char_length(label) <= 60) not valid;

alter table public.business_social_link
  add constraint business_social_link_label_length check (char_length(label) <= 60) not valid,
  add constraint business_social_link_url_length check (char_length(url) <= 500) not valid;

alter table public.business_contact
  add constraint business_contact_brand_description_length check (brand_description is null or char_length(brand_description) <= 300) not valid;

alter table public.staff_roster
  add constraint staff_roster_first_name_length check (char_length(first_name) <= 100) not valid,
  add constraint staff_roster_last_name_length check (last_name is null or char_length(last_name) <= 100) not valid,
  add constraint staff_roster_staff_role_length check (staff_role is null or char_length(staff_role) <= 100) not valid,
  add constraint staff_roster_email_length check (email is null or char_length(email) <= 254) not valid;
