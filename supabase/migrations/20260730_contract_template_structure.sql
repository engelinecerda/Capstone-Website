-- Reservation Form Configuration / Contract Template — Step 3.
--
-- Adds real structure on top of the existing per-package contract_templates
-- system, without replacing it:
--   - contract_template_clause: Layer 2 (editable) clauses, one row per
--     clause, scoped to a single package's template.
--   - contract_locked_clause: Layer 3 (legal boilerplate) clauses, GLOBAL —
--     shared by every template, since this text has no reason to vary by
--     package. Today this text is either hardcoded in the PDF renderer
--     (the "Client Acknowledgement" paragraph) or just another
--     unprotected free-text heading inside template_body (the "ELECTRONIC
--     SIGNATURE" clause) — seeded here with that exact current wording so
--     no contract's legal language changes on deploy.
--   - contract_field: Layer 1 row visibility/label/order. Only the
--     "summary" section is seeded — Reservation Summary is the only
--     section the PDF renderer builds from fixed label/value pairs today
--     (drawReservationSummary). "Selected Package" and "Venue Information"
--     are built by parsing whatever free text a clause contains
--     (splitDetailLine), not from discrete fields, so there is nothing
--     genuine to seed for those sections yet — the 'package'/'venue'
--     check-constraint values are reserved for if that ever changes.
--
-- template_body (the existing free-text blob) is left completely untouched
-- and keeps rendering exactly as it does today for any package whose
-- template hasn't been re-saved through the new structured editor — this
-- migration is purely additive.
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists public.contract_template_clause (
  clause_id   uuid primary key default gen_random_uuid(),
  template_id uuid not null references public.contract_templates(template_id) on delete cascade,
  heading     text not null,
  body        text not null,
  is_locked   boolean not null default false,
  sort_order  int not null default 0,
  updated_at  timestamptz not null default now()
);

create index if not exists contract_template_clause_template_id_idx
  on public.contract_template_clause (template_id);

create table if not exists public.contract_locked_clause (
  clause_id   uuid primary key default gen_random_uuid(),
  key         text not null unique,
  heading     text not null,
  body        text not null,
  sort_order  int not null default 0,
  updated_at  timestamptz not null default now()
);

create table if not exists public.contract_field (
  field_id    uuid primary key default gen_random_uuid(),
  token       text not null unique,
  label       text not null,
  section     text not null check (section in ('summary', 'package', 'venue')),
  is_visible  boolean not null default true,
  sort_order  int not null default 0
);

-- ── Seed: contract_field, from drawReservationSummary()'s current hardcoded
-- rows (generate-signed-contract/index.ts) ──────────────────────────────────
insert into public.contract_field (token, label, section, sort_order) values
  ('reservation_number', 'Reservation Number', 'summary', 0),
  ('customer_name',      'Client Name',        'summary', 1),
  ('event_type',         'Event Type',         'summary', 2),
  ('venue',              'Venue',              'summary', 3),
  ('package_name',       'Package',            'summary', 4),
  ('event_date',         'Event Date',         'summary', 5),
  ('event_time',         'Event Time',         'summary', 6),
  ('guest_count',        'Guests',             'summary', 7),
  ('total_price',        'Total Amount',       'summary', 8)
on conflict (token) do nothing;

-- ── Seed: contract_locked_clause, exact current wording ─────────────────────
insert into public.contract_locked_clause (key, heading, body, sort_order) values
  (
    'acknowledgement',
    'Client Acknowledgement',
    'By signing below, the Client acknowledges having read and understood this Agreement in full and agrees to be bound by its terms.',
    0
  ),
  (
    'electronic_signature',
    'Electronic Signature',
    'The Client acknowledges that this Agreement is being signed electronically, and agrees that such electronic signature is legally binding to the same extent as a handwritten signature, consistent with the Philippine Electronic Commerce Act (Republic Act No. 8792). By signing below, the Client confirms that the reservation details above are accurate and agrees to the terms of this Agreement and the Venue''s Terms and Conditions and Data Privacy Policy.',
    1
  )
on conflict (key) do nothing;

-- ── RLS: admin-only write, wide read for the editor + generation flow ───────
alter table public.contract_template_clause enable row level security;
alter table public.contract_locked_clause enable row level security;
alter table public.contract_field enable row level security;

drop policy if exists "Read contract template clauses" on public.contract_template_clause;
create policy "Read contract template clauses" on public.contract_template_clause
  for select using (true);

drop policy if exists "Admin manage contract template clauses" on public.contract_template_clause;
create policy "Admin manage contract template clauses" on public.contract_template_clause
  for all
  using (get_my_role() = 'admin')
  with check (get_my_role() = 'admin');

drop policy if exists "Read contract locked clauses" on public.contract_locked_clause;
create policy "Read contract locked clauses" on public.contract_locked_clause
  for select using (true);

drop policy if exists "Admin manage contract locked clauses" on public.contract_locked_clause;
create policy "Admin manage contract locked clauses" on public.contract_locked_clause
  for all
  using (get_my_role() = 'admin')
  with check (get_my_role() = 'admin');

drop policy if exists "Read contract fields" on public.contract_field;
create policy "Read contract fields" on public.contract_field
  for select using (true);

drop policy if exists "Admin manage contract fields" on public.contract_field;
create policy "Admin manage contract fields" on public.contract_field
  for all
  using (get_my_role() = 'admin')
  with check (get_my_role() = 'admin');
