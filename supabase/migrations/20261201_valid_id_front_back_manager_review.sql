-- Valid ID: front AND back photos, plus manager review of the ID.
--
-- Why
--   1. Customers now upload BOTH sides of their ID. Some IDs carry the
--      signature on the back, so the automatic check needs both photos, and
--      staff reviewing an ID need to see the whole card.
--   2. Some IDs are genuine but show no signature, so the automatic check can
--      never match them. A manager must be able to look at the ID and approve
--      (or ask for a replacement) instead of the contract being stuck.
--
-- What this adds
--   * profiles.valid_id_back_uploaded_at — flag for the back photo. The front
--     keeps using valid_id_uploaded_at and the existing object
--     customer-ids/<user_id>/valid-id.jpg, so every ID already on file stays
--     valid. The back lives at customer-ids/<user_id>/valid-id-back.jpg.
--   * reservation_contracts.id_check_status gains two values:
--       'manual_approved'  a manager viewed the ID and approved the contract
--       'id_rejected'      a manager asked the customer for a new ID
--     plus id_review_note / id_reviewed_by / id_reviewed_at to record who
--     decided and why.
--   * valid_id_access_log — one row every time a manager opens a customer's
--     ID, so access to personal documents is traceable.
--
-- Privacy
--   The bucket stays private and there is STILL no storage policy that lets
--   staff read it. Managers only ever see an ID through the `review-customer-id`
--   Edge Function, which checks the caller is a manager, hands back a 2-minute
--   signed link for ONE reservation's customer, and writes a log row first.
--   (Admin role: no access, matching every other operational action.)
-- ─────────────────────────────────────────────────────────────────────────────

-- 1. Back-of-ID flag ---------------------------------------------------------
alter table public.profiles
  add column if not exists valid_id_back_uploaded_at timestamptz;

comment on column public.profiles.valid_id_back_uploaded_at is
  'When the customer last saved the BACK of their valid ID (storage: customer-ids/<user_id>/valid-id-back.jpg). NULL = no back photo on file.';

-- 2. Manager review state ----------------------------------------------------
alter table public.reservation_contracts
  add column if not exists id_review_note   text,
  add column if not exists id_reviewed_by   uuid,
  add column if not exists id_reviewed_at   timestamptz;

alter table public.reservation_contracts
  drop constraint if exists reservation_contracts_id_check_status_check;
alter table public.reservation_contracts
  add constraint reservation_contracts_id_check_status_check
  check (id_check_status is null or id_check_status in (
    'checking', 'matched', 'mismatch', 'no_id_signature',
    'unclear_id', 'unclear_signature', 'error',
    'manual_approved', 'id_rejected'
  ));

-- 3. Access log --------------------------------------------------------------
create table if not exists public.valid_id_access_log (
  log_id         uuid primary key default gen_random_uuid(),
  viewer_id      uuid not null,
  customer_id    uuid not null,
  reservation_id uuid references public.reservations(reservation_id) on delete set null,
  action         text not null default 'view',
  created_at     timestamptz not null default now()
);

create index if not exists valid_id_access_log_customer_idx
  on public.valid_id_access_log (customer_id, created_at desc);

alter table public.valid_id_access_log enable row level security;

drop policy if exists "valid id log: staff can read" on public.valid_id_access_log;
create policy "valid id log: staff can read"
  on public.valid_id_access_log for select to authenticated
  using (get_my_role() in ('manager', 'admin'));
-- No insert/update/delete policy: only the service-role Edge Function writes.

-- Deploy
--   npx supabase functions deploy review-customer-id
--   npx supabase functions deploy generate-signed-contract
--   npx supabase functions deploy verify-id-signature
