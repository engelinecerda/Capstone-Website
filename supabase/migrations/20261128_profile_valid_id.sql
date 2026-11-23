-- Valid ID now lives on the customer's profile ("My Profile" -> Valid ID).
--
-- Before: the ID photo was uploaded on every reservation, compared with the
-- e-signature once and thrown away. Customers had to re-upload it for every
-- booking, every retry and every re-sign.
--
-- After: the customer uploads the ID once on My Profile (or during their first
-- reservation, which saves it there). It is then used to validate the
-- e-signature on every contract, and the customer can replace or remove it at
-- any time. If a customer already has an ID on file, the reservation form no
-- longer asks for one.
--
-- What this migration adds:
--   1. profiles.valid_id_uploaded_at — a flag/timestamp ("has an ID on file").
--      The file itself is NOT in the profile row.
--   2. A PRIVATE storage bucket `customer-ids` (no public URLs, JPEG only) that
--      holds ONE object per customer at  <user_id>/valid-id.jpg
--   3. Storage policies so a signed-in customer can read / write / replace /
--      delete ONLY the object inside their own <user_id>/ folder.
--
-- Security notes:
--   * The path is fixed (<auth.uid()>/valid-id.jpg) and the Edge Functions build
--     it from the verified caller id — they never trust a path (or a column
--     value) supplied by the browser, so nobody can point the check at someone
--     else's ID.
--   * There is deliberately NO manager/admin read policy: staff cannot open a
--     customer's ID from the dashboard. Only the customer (and the service-role
--     Edge Functions that run the signature check) can read it. Add a policy
--     here later if the business decides staff must be able to view it.
--   * The bucket is not public; the profile page shows the preview through a
--     short-lived signed URL.
-- ─────────────────────────────────────────────────────────────────────────────

-- 1. Flag on the profile -----------------------------------------------------
alter table public.profiles
  add column if not exists valid_id_uploaded_at timestamptz;

comment on column public.profiles.valid_id_uploaded_at is
  'When the customer last saved a valid ID photo (storage: customer-ids/<user_id>/valid-id.jpg). NULL = no ID on file.';

-- 2. Private bucket ----------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('customer-ids', 'customer-ids', false, 4194304, array['image/jpeg'])
on conflict (id) do update
  set public             = false,
      file_size_limit    = 4194304,
      allowed_mime_types = array['image/jpeg'];

-- 3. Owner-only access -------------------------------------------------------
drop policy if exists "customer ids: owner can read"   on storage.objects;
drop policy if exists "customer ids: owner can upload" on storage.objects;
drop policy if exists "customer ids: owner can replace" on storage.objects;
drop policy if exists "customer ids: owner can delete" on storage.objects;

create policy "customer ids: owner can read"
  on storage.objects for select to authenticated
  using (
    bucket_id = 'customer-ids'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

create policy "customer ids: owner can upload"
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'customer-ids'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

-- "Replace" is an upsert, which needs UPDATE as well as INSERT.
create policy "customer ids: owner can replace"
  on storage.objects for update to authenticated
  using (
    bucket_id = 'customer-ids'
    and (storage.foldername(name))[1] = auth.uid()::text
  )
  with check (
    bucket_id = 'customer-ids'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

create policy "customer ids: owner can delete"
  on storage.objects for delete to authenticated
  using (
    bucket_id = 'customer-ids'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

-- Notes
--   * Existing customers simply have no ID on file (valid_id_uploaded_at is
--     NULL) and are asked for one on their next reservation, or can add it on
--     My Profile.
--   * Deploy the updated Edge Functions with the CLI (they import _shared/):
--       npx supabase functions deploy generate-signed-contract
--       npx supabase functions deploy verify-id-signature
