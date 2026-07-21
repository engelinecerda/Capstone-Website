-- ── Digital contract signing redesign ─────────────────────────────────────────
-- Replaces "download a static PDF, sign externally, upload a scan, guess via
-- Vision API if a signature is present" with in-app e-signature capture:
--   1. contract_templates.template_body — plain text with {{placeholder}}
--      tokens, rendered in-page for the customer to review before signing.
--   2. contract_signatures — normalized signature record (one row per signer),
--      built now (not just a future hook) so multi-signatory / witness /
--      admin-signature support later doesn't require a schema rework.
--   3. reservation_contracts.template_version_no — snapshot of which template
--      version was actually shown/signed, so later template edits don't
--      retroactively change what a historical contract "said."
-- All writes to reservation_contracts/contract_signatures now happen from the
-- generate-signed-contract edge function (service role), not the client —
-- the signed PDF is server-authoritative, matching the pattern already used
-- by verify-contract/ocr-payment.
-- ─────────────────────────────────────────────────────────────────────────────

alter table public.contract_templates
  add column if not exists template_body text;

alter table public.reservation_contracts
  add column if not exists template_version_no integer;

create table if not exists public.contract_signatures (
  signature_id       uuid        primary key default gen_random_uuid(),
  reservation_id     uuid        not null references public.reservations(reservation_id) on delete cascade,
  signer_role        text        not null default 'customer',
  signer_name        text        not null,
  signature_type     text        not null check (signature_type in ('drawn', 'typed')),
  signature_image_url text       not null,
  signed_at          timestamptz not null default now(),
  created_at         timestamptz not null default now()
);

create index if not exists contract_signatures_reservation_id_idx
  on public.contract_signatures (reservation_id);

alter table public.contract_signatures enable row level security;

-- Only admins/managers and the owning customer can read signature records.
-- No insert/update/delete policy — only the service role (edge function)
-- writes here, and the service role bypasses RLS entirely.
create policy "read own signatures" on public.contract_signatures for select
  using (
    exists (
      select 1 from public.reservations r
      where r.reservation_id = contract_signatures.reservation_id
        and r.user_id = auth.uid()
    )
  );

create policy "admin read all signatures" on public.contract_signatures for select
  using (get_my_role() in ('manager', 'admin'));
