-- Reservation Form Configuration / Contract Template — Step 1: immutability
-- hardening, done first so already-signed contracts are protected before the
-- template becomes admin-editable.
--
-- Two real gaps found in the existing contract pipeline:
--
-- 1. reservation_contracts has an UPDATE policy for role 'manager' (added in
--    20260713_fix_reservation_contracts_rls.sql for the legitimate contract
--    review workflow — approving/requesting resubmission sets review_status,
--    review_notes, reviewed_at, verified_date). RLS policies can't restrict
--    which columns an UPDATE touches, so as written that policy could also
--    let a manager overwrite contract_url or template_version_no via the
--    client SDK. A BEFORE UPDATE trigger closes that: the review workflow
--    keeps working, the frozen/signed fields become genuinely immutable.
--
-- 2. reservation_contracts only stores the PDF URL — there's no resolved-text
--    snapshot. Add rendered_body so a signed contract can be inspected/
--    displayed without needing to open the PDF, and so "viewing a past
--    contract reads the stored snapshot" has an actual snapshot to read.
--
-- 3. contract_templates (the live per-package editable template) has no RLS
--    at all today — confirmed by grep, no prior migration ever enabled it.
--    admin/contracts.html is only a UI-layer guard. Add the standard
--    admin-only-write policy used everywhere else in this project.
-- ─────────────────────────────────────────────────────────────────────────────

alter table public.reservation_contracts
  add column if not exists rendered_body text;

create or replace function public.protect_signed_contract_fields()
returns trigger
language plpgsql
as $$
begin
  if new.reservation_id        is distinct from old.reservation_id
    or new.template_id         is distinct from old.template_id
    or new.template_version_no is distinct from old.template_version_no
    or new.contract_type       is distinct from old.contract_type
    or new.contract_url        is distinct from old.contract_url
    or new.rendered_body       is distinct from old.rendered_body
  then
    raise exception 'reservation_contracts: signed contract fields are immutable';
  end if;
  return new;
end;
$$;

drop trigger if exists protect_signed_contract_fields on public.reservation_contracts;
create trigger protect_signed_contract_fields
  before update on public.reservation_contracts
  for each row execute function public.protect_signed_contract_fields();

-- contract_templates: admin-only write, matching the standard convention
-- (get_my_role() = 'admin', FOR ALL). Wide read for manager/admin (they need
-- to see templates in admin/contracts.html) and public read of active
-- templates (the customer-facing in-page preview in reservations.html reads
-- contract_templates directly before signing).
alter table public.contract_templates enable row level security;

drop policy if exists "Public read active contract templates" on public.contract_templates;
create policy "Public read active contract templates" on public.contract_templates
  for select using (is_active = true);

drop policy if exists "Admin manage all contract templates" on public.contract_templates;
create policy "Admin manage all contract templates" on public.contract_templates
  for all
  using (get_my_role() = 'admin')
  with check (get_my_role() = 'admin');

drop policy if exists "Manager read all contract templates" on public.contract_templates;
create policy "Manager read all contract templates" on public.contract_templates
  for select
  using (get_my_role() in ('manager', 'admin'));
