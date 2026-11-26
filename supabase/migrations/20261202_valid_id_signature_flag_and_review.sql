-- Valid ID: flag IDs that have no signature, and let a manager approve or reject
-- the ID.
--
-- Why
--   Plenty of valid IDs carry no signature, and the contract check compares the
--   ID's signature with the e-signature, so those IDs could never pass. Right
--   after a customer saves their ID, the `check-valid-id` Edge Function reads
--   it (Gemini vision, same as the receipt/payment OCR) and records whether a
--   signature was found. An ID with none is FLAGGED and waits for a manager,
--   who approves it (valid ID, no signature) or rejects it (customer must
--   upload a new one).
--
-- What this adds
--   * valid_id_review: ONE row per customer. status:
--       unchecked  not checked yet, or the photos were just replaced
--       clear      a signature was found: no review needed
--       flagged    no signature found: waiting for a manager
--       approved   a manager accepted the ID
--       rejected   a manager rejected it: a new ID is needed
--     Customers can read only their own row. NOBODY writes it from the browser:
--     the Edge Functions (service role) are the only writers, so a customer
--     cannot approve their own ID. (That is also why this is a separate table
--     and not a column on profiles, which customers can update.)
--   * A trigger that resets the row to 'unchecked' whenever the customer saves,
--     replaces or removes a photo, so an approval can never carry over to a
--     different ID.
--   * reservation_contracts.id_check_status gains 'awaiting_id_review'
--     (the contract waits for the manager's decision on the ID).
-- ─────────────────────────────────────────────────────────────────────────────

-- 1. Review table ------------------------------------------------------------
create table if not exists public.valid_id_review (
  user_id         uuid primary key references public.profiles(user_id) on delete cascade,
  status          text not null default 'unchecked'
                  check (status in ('unchecked', 'clear', 'flagged', 'approved', 'rejected')),
  signature_check text check (signature_check is null or signature_check in
                  ('signature_found', 'no_signature', 'unclear', 'not_an_id')),
  review_note     text,
  reviewed_by     uuid,
  reviewed_at     timestamptz,
  checked_at      timestamptz,
  updated_at      timestamptz not null default now()
);

comment on table public.valid_id_review is
  'Upload-time signature check and manager decision for a customer''s valid ID. Written only by Edge Functions (service role).';

alter table public.valid_id_review enable row level security;

drop policy if exists "valid id review: owner can read" on public.valid_id_review;
create policy "valid id review: owner can read"
  on public.valid_id_review for select to authenticated
  using (user_id = auth.uid());

drop policy if exists "valid id review: staff can read" on public.valid_id_review;
create policy "valid id review: staff can read"
  on public.valid_id_review for select to authenticated
  using (get_my_role() in ('manager', 'admin'));
-- No insert/update/delete policies on purpose.

-- 2. Reset when the photos change ---------------------------------------------
create or replace function public.reset_valid_id_review()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.valid_id_uploaded_at is null and new.valid_id_back_uploaded_at is null then
    delete from public.valid_id_review where user_id = new.user_id;
  else
    insert into public.valid_id_review (user_id, status, updated_at)
    values (new.user_id, 'unchecked', now())
    on conflict (user_id) do update
      set status          = 'unchecked',
          signature_check = null,
          review_note     = null,
          reviewed_by     = null,
          reviewed_at     = null,
          checked_at      = null,
          updated_at      = now();
  end if;
  return new;
end;
$$;

drop trigger if exists trg_reset_valid_id_review on public.profiles;
create trigger trg_reset_valid_id_review
  after update of valid_id_uploaded_at, valid_id_back_uploaded_at on public.profiles
  for each row
  when (
    old.valid_id_uploaded_at      is distinct from new.valid_id_uploaded_at
    or old.valid_id_back_uploaded_at is distinct from new.valid_id_back_uploaded_at
  )
  execute function public.reset_valid_id_review();

-- 3. Contract state ------------------------------------------------------------
alter table public.reservation_contracts
  drop constraint if exists reservation_contracts_id_check_status_check;
alter table public.reservation_contracts
  add constraint reservation_contracts_id_check_status_check
  check (id_check_status is null or id_check_status in (
    'checking', 'matched', 'mismatch', 'no_id_signature',
    'unclear_id', 'unclear_signature', 'error',
    'manual_approved', 'id_rejected', 'awaiting_id_review'
  ));

-- Deploy
--   npx supabase functions deploy check-valid-id review-customer-id generate-signed-contract verify-id-signature
