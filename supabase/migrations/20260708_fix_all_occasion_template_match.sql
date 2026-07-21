-- ── Fix: All-Occasion contract template never attached to some packages ──────
-- The original seed (20260707_seed_contract_templates.sql) required BOTH a
-- name match AND `location_type = 'offsite'` for the All-Occasion block. The
-- name pattern alone ('%all-occasion%' / '%all occasion%') is already
-- specific enough — requiring location_type too meant any package whose
-- location_type didn't exactly match 'offsite' silently got no template at
-- all, falling back to the generic default contract. This re-attempts the
-- attach without the location_type requirement, still guarded so it only
-- fills in packages that still have zero contract_templates rows (never
-- touches a package an admin has since configured by hand).
-- ─────────────────────────────────────────────────────────────────────────────

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
where (p.package_name ilike '%all-occasion%' or p.package_name ilike '%all occasion%')
  and not exists (select 1 from public.contract_templates ct where ct.package_id = p.package_id);
