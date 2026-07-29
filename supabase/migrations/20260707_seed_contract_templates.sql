-- ── Seed contract_templates.template_body from the legacy static PDF contracts ─
-- The old system served customers a hardcoded, generic-per-package-name PDF
-- (files/contracts/*.pdf, wired via the now-removed CONTRACT_FILES map in
-- reservations.html). Those documents contain real, package-specific terms
-- (pricing tiers, inclusions, cancellation/rescheduling fees) that must not
-- be lost now that contracts are dynamically rendered from
-- contract_templates.template_body. This migration converts each legacy PDF's
-- text into a token-merged template and attaches it to every currently
-- active package it applied to, matched by name (one-time backfill — future
-- packages get their template set explicitly via admin/contracts.html, not
-- by name matching).
--
-- Safe to re-run: skips any package that already has at least one
-- contract_templates row, so it never overwrites an admin's own edits.
--
-- contract_templates.created_by is NOT NULL, but this seed runs outside any
-- admin session (no auth.uid()) — attribute these seeded rows to the
-- earliest admin/manager account instead.
-- ─────────────────────────────────────────────────────────────────────────────

do $$
begin
  if not exists (select 1 from public.profiles where role in ('admin', 'manager')) then
    raise exception 'No admin/manager profile found to attribute seeded contract templates to. Create an admin/manager account first, then re-run this migration.';
  end if;
end;
$$;

-- 1. VIP Lounge (VIP Lite / VIP Plus / VIP Max) ───────────────────────────────
insert into public.contract_templates (package_id, version_no, contract_type, description, template_url, template_body, is_active, created_by)
select
  p.package_id, 1, 'VIP Lounge Event Agreement',
  'Seeded from the legacy contract-vip-lounge.pdf.',
  '/files/contracts/contract-vip-lounge.pdf',
$tmpl$ELI COFFEE
VIP LOUNGE MINI GATHERING EVENT AGREEMENT

This agreement is made between ELI Coffee Events Cafe Binangonan ("the Venue") and {{customer_name}} ("the Client").

EVENT DETAILS
Reservation Number: {{reservation_number}}
Event Type: {{event_type}}
Event Date: {{event_date}}
Event Time: {{event_time}}
Number of Guests: {{guest_count}}
Package: {{package_name}}
Total Package Price: {{total_price}}

VENUE DETAILS
VIP Lounge — Ideal Capacity: 15–18 pax, Maximum Capacity: 20 pax.

PACKAGE TIERS
VIP Lite (₱2,999) — 2 hours use of VIP Lounge, ₱2,000 Food & Drinks Credit.
VIP Plus (₱3,999) — 3 hours use of VIP Lounge, ₱2,499 Food & Drinks Credit.
VIP Max (₱4,999) — 4 hours use of VIP Lounge, ₱3,000 Food & Drinks Credit.
Extension Hour: ₱800 per hour.

INCLUSIONS
Air-conditioned venue, food and drinks consumable credit, basic sound system, TV for presentation, karaoke access, and arcade games access.

PAYMENT TERMS
The reservation may be secured through full payment, 50% down payment, or a reservation fee. The remaining balance must be settled before the payment deadline set by the Venue.

CANCELLATION POLICY
All payments made are NON-REFUNDABLE.

RESCHEDULING POLICY
Rescheduling is subject to venue availability. A ₱3,000 rescheduling fee will apply.

ELECTRONIC SIGNATURE
The Client acknowledges that this Agreement is signed electronically and agrees that such electronic signature is legally binding to the same extent as a handwritten signature, consistent with the Philippine Electronic Commerce Act (Republic Act No. 8792).

By signing below, the Client confirms that the reservation details above are accurate and agrees to the terms of this Agreement and the Venue's Terms and Conditions and Data Privacy Policy.$tmpl$,
  true,
  (select user_id from public.profiles where role in ('admin', 'manager') order by created_at limit 1)
from public.package p
where p.location_type = 'onsite' and p.package_name ilike '%vip%'
  and not exists (select 1 from public.contract_templates ct where ct.package_id = p.package_id);


-- 2. Main Hall (Main Hall Basic / Main Hall Plus) ─────────────────────────────
insert into public.contract_templates (package_id, version_no, contract_type, description, template_url, template_body, is_active, created_by)
select
  p.package_id, 1, 'Main Hall Event Agreement',
  'Seeded from the legacy contract-main-hall.pdf.',
  '/files/contracts/contract-main-hall.pdf',
$tmpl$ELI COFFEE
MAIN HALL MINI GATHERING EVENT AGREEMENT

This agreement is between ELI Coffee Events Cafe Binangonan ("the Venue") and {{customer_name}} ("the Client").

EVENT DETAILS
Reservation Number: {{reservation_number}}
Event Type: {{event_type}}
Event Date: {{event_date}}
Event Time: {{event_time}}
Number of Guests: {{guest_count}}
Package: {{package_name}}
Total Package Price: {{total_price}}

VENUE DETAILS
Main Hall — Ideal Capacity: up to 25 pax, Maximum Capacity: 30 pax.

PACKAGE TIERS
Main Hall Basic (₱9,999) — 2 hours use of Main Hall, ₱8,000 Food & Drinks Credit.
Main Hall Plus (₱11,999) — 3 hours use of Main Hall, ₱9,000 Food & Drinks Credit.
Extension Hour: ₱1,000 per hour.

INCLUSIONS
Fully air-conditioned venue, consumable food and drinks credit, basic sound system, TV presentation access, karaoke use, and arcade games access.

PAYMENT TERMS
The reservation may be secured through full payment, down payment, or a reservation fee. The remaining balance must be paid before the payment deadline set by the Venue.

CANCELLATION POLICY
All payments made are NON-REFUNDABLE.

RESCHEDULING POLICY
A ₱3,000 rescheduling fee applies and is subject to venue availability.

ELECTRONIC SIGNATURE
The Client acknowledges that this Agreement is signed electronically and agrees that such electronic signature is legally binding to the same extent as a handwritten signature, consistent with the Philippine Electronic Commerce Act (Republic Act No. 8792).

By signing below, the Client confirms that the reservation details above are accurate and agrees to the terms of this Agreement and the Venue's Terms and Conditions and Data Privacy Policy.$tmpl$,
  true,
  (select user_id from public.profiles where role in ('admin', 'manager') order by created_at limit 1)
from public.package p
where p.location_type = 'onsite' and p.package_name ilike '%main hall%'
  and not exists (select 1 from public.contract_templates ct where ct.package_id = p.package_id);


-- 3. Snack Bar Corner (onsite add-on and offsite snack packages) ─────────────
insert into public.contract_templates (package_id, version_no, contract_type, description, template_url, template_body, is_active, created_by)
select
  p.package_id, 1, 'Snack Bar Corner Service Agreement',
  'Seeded from the legacy contract-snack-bar.pdf.',
  '/files/contracts/contract-snack-bar.pdf',
$tmpl$ELI COFFEE
SNACK BAR CORNER SERVICE AGREEMENT

This agreement is made between ELI Coffee Events Cafe Binangonan ("the Venue") and {{customer_name}} ("the Client").

EVENT DETAILS
Reservation Number: {{reservation_number}}
Event Type: {{event_type}}
Event Date: {{event_date}}
Event Time: {{event_time}}
Venue: {{venue}}
Package: {{package_name}}
Total Package Price: {{total_price}}

PACKAGE INCLUSIONS
Good for 30–50 pax, 2–3 hours of service, full snack mobile bar setup, and an overflowing chocolate fountain.

PACKAGE OPTIONS
Biscuits and Candies (₱3,500) — biscuits, assorted candies, marshmallows, caramel bars, brownies, and 20 pcs doughnut.
Biscuits, Candies, and Fruits (₱4,000) — biscuits, candies, marshmallows, and four kinds of seasonal fruits.
Biscuits, Chips, and Drinks (₱5,000) — biscuits, chips, cupcakes, marshmallows, caramel bars, brownies, and two drinks.

PAYMENT TERMS
The reservation may be confirmed through full payment, 50% down payment, or a reservation fee. Any reservation fee paid will be deducted from the total package amount. The remaining balance must be settled within the payment deadline provided by the Venue.

CANCELLATION POLICY
All payments made are STRICTLY NON-REFUNDABLE.

RESCHEDULING POLICY
Rescheduling may be requested depending on availability. A ₱3,000 rescheduling fee will apply.

ELECTRONIC SIGNATURE
The Client acknowledges that this Agreement is signed electronically and agrees that such electronic signature is legally binding to the same extent as a handwritten signature, consistent with the Philippine Electronic Commerce Act (Republic Act No. 8792).

By signing below, the Client confirms that the reservation details above are accurate and agrees to the terms of this Agreement and the Venue's Terms and Conditions and Data Privacy Policy.$tmpl$,
  true,
  (select user_id from public.profiles where role in ('admin', 'manager') order by created_at limit 1)
from public.package p
where (p.package_name ilike '%snack%' or p.package_name ilike '%biscuit%')
  and not exists (select 1 from public.contract_templates ct where ct.package_id = p.package_id);


-- 4. Coffee Bar (offsite) ──────────────────────────────────────────────────────
insert into public.contract_templates (package_id, version_no, contract_type, description, template_url, template_body, is_active, created_by)
select
  p.package_id, 1, 'Coffee Bar Service Agreement',
  'Seeded from the legacy contract-coffee-bar.pdf.',
  '/files/contracts/contract-coffee-bar.pdf',
$tmpl$ELI COFFEE
COFFEE BAR SERVICE AGREEMENT

This agreement is between ELI Coffee Events Cafe Binangonan ("the Service Provider") and {{customer_name}} ("the Client").

EVENT DETAILS
Reservation Number: {{reservation_number}}
Event Type: {{event_type}}
Event Date: {{event_date}}
Event Time: {{event_time}}
Event Location: {{venue}}
Number of Guests: {{guest_count}}
Selected Package: {{package_name}}
Total Package Price: {{total_price}}

PACKAGE TIERS
30 pax — ₱3,990
50 pax — ₱5,990
100 pax — ₱10,990
150 pax — ₱14,990

PACKAGE INCLUSIONS
Transportation fees, full table setup, 2–3 baristas, three (3) hours of service, 1:1 coffee serving, coffee tasting for two (2), and a choice of iced or hot coffee (12oz).

SPECIAL OFFER
Clients with 100–150 pax may receive free use of the Eli Coffee store as a prenup venue.

AREA COVERAGE
Rizal Area — less than 10 km from Eli Coffee Binangonan. Out of Town — 11 km and above (additional fees may apply).

PAYMENT TERMS
The reservation may be confirmed through full payment, 50% down payment, or a reservation fee. Any reservation fee paid will be deducted from the total package amount. The remaining balance must be settled before the payment deadline set by the Venue.

CANCELLATION POLICY
All payments made, including reservation fees and down payments, are STRICTLY NON-REFUNDABLE.

RESCHEDULING POLICY
Rescheduling is subject to availability of the requested date. A ₱3,000 rescheduling fee will apply.

ELECTRONIC SIGNATURE
The Client acknowledges that this Agreement is signed electronically and agrees that such electronic signature is legally binding to the same extent as a handwritten signature, consistent with the Philippine Electronic Commerce Act (Republic Act No. 8792).

By signing below, the Client confirms the reservation and agrees to the terms and conditions stated above, including the Venue's Terms and Conditions and Data Privacy Policy.$tmpl$,
  true,
  (select user_id from public.profiles where role in ('admin', 'manager') order by created_at limit 1)
from public.package p
where p.location_type = 'offsite' and p.package_name ilike '%coffee%'
  and not exists (select 1 from public.contract_templates ct where ct.package_id = p.package_id);


-- 5. All-Occasion Party Package (Essential / Standard, offsite) ───────────────
insert into public.contract_templates (package_id, version_no, contract_type, description, template_url, template_body, is_active, created_by)
select
  p.package_id, 1, 'All-Occasion Party Package Agreement',
  'Seeded from the legacy all-occassion-party-package.pdf.',
  '/files/contracts/all-occassion-party-package.pdf',
$tmpl$ELI EVENTS & CATERING
ALL OCCASION PARTY PACKAGE AGREEMENT

This agreement is between ELI Events & Catering ("the Venue") and {{customer_name}} ("the Client").

EVENT DETAILS
Reservation Number: {{reservation_number}}
Event Type: {{event_type}}
Event Date: {{event_date}}
Event Time: {{event_time}}
Event Location: {{venue}}
Number of Guests (PAX): {{guest_count}}
Package: {{package_name}}
Total Package Price: {{total_price}}

ESSENTIAL CATERING PACKAGE
1 pork dish, 1 chicken dish, 1 fish or vegetable dish, 1 pasta or noodles, 1 dessert, steamed rice, iced tea or juice, and purified drinking water. Full buffet setup, complete utensils, dressed round tables, dressed monoblock chairs with bow accent, cake table and gift table, uniformed service staff, food servers and controllers, basic backdrop and stage setup, balloon and styrofoam letters (up to 6 letters), table centerpieces, and balloon or flower accents with table numbers.

STANDARD CATERING PACKAGE
Everything in the Essential package, with a choice of pork or beef dish, plus optional add-ons: professional event host/singer, lights and sounds, photo booth or photo coverage, grazing table, coffee station, and one (1) reception coordinator.

PRICING
Essential — 50 pax: ₱28,000, 100 pax: ₱48,000, additional head: ₱450.
Standard — 50 pax: ₱58,000, 100 pax: ₱82,000, additional head: ₱550.

PAYMENT TERMS
The reservation may be secured through a reservation fee, down payment, or full payment. Full payment or the required balance must be settled before the event date, based on the agreed deadline. Proof of payment must be submitted for verification.

SERVICE CONDITIONS
Service duration and setup time will be based on the agreed event schedule. The Client must ensure accessibility of the venue for setup and operation. Additional charges may apply for extended service hours or special requests.

CANCELLATION POLICY
All payments made are STRICTLY NON-REFUNDABLE.

RESCHEDULING POLICY
A ₱3,000 rescheduling fee will be charged. Rescheduling is subject to availability of the new event date.

CLIENT RESPONSIBILITIES
The Client must provide accurate event details and final guest count. Any damages caused by guests to equipment or setup will be charged accordingly. The Client must comply with venue rules and regulations.

LIMITATIONS
Menu items and inclusions are fixed unless otherwise agreed. Additional services not listed in the package will incur extra charges. Transportation is included within 5KM; additional fees apply beyond coverage.

ELECTRONIC SIGNATURE
The Client acknowledges that this Agreement is signed electronically and agrees that such electronic signature is legally binding to the same extent as a handwritten signature, consistent with the Philippine Electronic Commerce Act (Republic Act No. 8792).

By signing below, both parties agree to the terms and conditions stated above.$tmpl$,
  true,
  (select user_id from public.profiles where role in ('admin', 'manager') order by created_at limit 1)
from public.package p
where p.location_type = 'offsite'
  and (p.package_name ilike '%all-occasion%' or p.package_name ilike '%all occasion%')
  and not exists (select 1 from public.contract_templates ct where ct.package_id = p.package_id);


-- 6. Generic Catering fallback (any other offsite 'main' package not covered above) ─
insert into public.contract_templates (package_id, version_no, contract_type, description, template_url, template_body, is_active, created_by)
select
  p.package_id, 1, 'Catering Service Agreement',
  'Seeded from the legacy contract-catering.pdf.',
  '/files/contracts/contract-catering.pdf',
$tmpl$ELI COFFEE
CATERING SERVICE AGREEMENT

This agreement is made between ELI Coffee Events Cafe Binangonan ("the Venue") and {{customer_name}} ("the Client").

EVENT DETAILS
Reservation Number: {{reservation_number}}
Event Type: {{event_type}}
Event Date: {{event_date}}
Event Time: {{event_time}}
Event Location: {{venue}}
Estimated Guests: {{guest_count}}
Package: {{package_name}}
Total Package Price: {{total_price}}

PACKAGE INCLUSIONS
Catering buffet setup, three (3) main dishes, one (1) pasta, rice, dessert, drink, a set of utensils, uniformed waiters and servers, dressed tables and chairs, basic backdrop stage setup, a table centerpiece, and 3–4 hours of service. Crew meal and transportation fees may apply.

SPECIAL OFFER
Free overflowing coffee and one (1) appetizer or dessert.

PAYMENT TERMS
The reservation may be confirmed through full payment, 50% down payment, or a reservation fee. Reservation fee payments will be deducted from the total package amount. The remaining balance must be settled before the payment deadline.

CANCELLATION POLICY
All payments made are STRICTLY NON-REFUNDABLE.

RESCHEDULING POLICY
Rescheduling may be requested depending on availability, with a ₱3,000 rescheduling fee.

ELECTRONIC SIGNATURE
The Client acknowledges that this Agreement is signed electronically and agrees that such electronic signature is legally binding to the same extent as a handwritten signature, consistent with the Philippine Electronic Commerce Act (Republic Act No. 8792).

By signing below, the Client confirms that the reservation details above are accurate and agrees to the terms of this Agreement and the Venue's Terms and Conditions and Data Privacy Policy.$tmpl$,
  true,
  (select user_id from public.profiles where role in ('admin', 'manager') order by created_at limit 1)
from public.package p
where p.location_type = 'offsite' and p.package_type = 'main'
  and p.package_name ilike '%catering%'
  and p.package_name not ilike '%all-occasion%' and p.package_name not ilike '%all occasion%'
  and not exists (select 1 from public.contract_templates ct where ct.package_id = p.package_id);
