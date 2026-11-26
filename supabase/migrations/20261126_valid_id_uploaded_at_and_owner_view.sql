-- Lets a customer see their own saved ID (thumbnail) and when it was saved.
alter table public.profiles add column if not exists valid_id_uploaded_at timestamptz;

create or replace function public.reset_valid_id_review_on_upload()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    if auth.uid() is not null then
      new.valid_id_front_path := null;
      new.valid_id_back_path := null;
      new.valid_id_status := 'none';
      new.valid_id_review_note := null;
      new.valid_id_reviewed_at := null;
      new.valid_id_scan_note := null;
      new.valid_id_uploaded_at := null;
    end if;
    return new;
  end if;
  -- Browser clients may replace/remove their own photos, but all scan and
  -- review outcomes are written only by service-role Edge Functions.
  if auth.uid() is not null then
    new.valid_id_status := old.valid_id_status;
    new.valid_id_review_note := old.valid_id_review_note;
    new.valid_id_reviewed_at := old.valid_id_reviewed_at;
    new.valid_id_scan_note := old.valid_id_scan_note;
    new.valid_id_uploaded_at := old.valid_id_uploaded_at;
  end if;
  if auth.uid() is not null and (
     new.valid_id_front_path is distinct from old.valid_id_front_path
     or new.valid_id_back_path is distinct from old.valid_id_back_path
  ) then
    new.valid_id_status := case when new.valid_id_front_path is null and new.valid_id_back_path is null then 'none' else 'unchecked' end;
    new.valid_id_review_note := null;
    new.valid_id_reviewed_at := null;
    new.valid_id_scan_note := null;
    new.valid_id_uploaded_at := case when new.valid_id_front_path is null and new.valid_id_back_path is null then null else now() end;
  end if;
  return new;
end;
$$;

-- Owner-only read so the account page can create a signed URL for the
-- customer's own ID preview. Staff access still goes through review-customer-id.
drop policy if exists "Customers view own valid IDs" on storage.objects;
create policy "Customers view own valid IDs" on storage.objects
for select to authenticated using (
  bucket_id = 'customer-valid-ids' and (storage.foldername(name))[1] = auth.uid()::text
);
