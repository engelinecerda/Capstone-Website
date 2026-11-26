-- Private customer identity uploads and staff review state.
alter table public.profiles
  add column if not exists valid_id_front_path text,
  add column if not exists valid_id_back_path text,
  add column if not exists valid_id_status text not null default 'none'
    check (valid_id_status in ('none', 'unchecked', 'clear', 'flagged', 'approved', 'rejected')),
  add column if not exists valid_id_review_note text,
  add column if not exists valid_id_reviewed_at timestamptz,
  add column if not exists valid_id_scan_note text;

create table if not exists public.valid_id_review_logs (
  id bigint generated always as identity primary key,
  customer_id uuid not null references public.profiles(user_id) on delete cascade,
  actor_id uuid not null references auth.users(id),
  action text not null check (action in ('view', 'approve', 'reject', 'upload', 'scan')),
  note text,
  created_at timestamptz not null default now()
);
alter table public.valid_id_review_logs enable row level security;
revoke all on public.valid_id_review_logs from anon, authenticated;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('customer-valid-ids', 'customer-valid-ids', false, 10485760, array['image/jpeg','image/png','image/webp'])
on conflict (id) do update set public = false, file_size_limit = 10485760,
  allowed_mime_types = array['image/jpeg','image/png','image/webp'];

drop policy if exists "Customers upload own valid IDs" on storage.objects;
create policy "Customers upload own valid IDs" on storage.objects
for insert to authenticated with check (
  bucket_id = 'customer-valid-ids' and (storage.foldername(name))[1] = auth.uid()::text
);
drop policy if exists "Customers replace own valid IDs" on storage.objects;
create policy "Customers replace own valid IDs" on storage.objects
for update to authenticated using (
  bucket_id = 'customer-valid-ids' and (storage.foldername(name))[1] = auth.uid()::text
) with check (
  bucket_id = 'customer-valid-ids' and (storage.foldername(name))[1] = auth.uid()::text
);
drop policy if exists "Customers remove own valid IDs" on storage.objects;
create policy "Customers remove own valid IDs" on storage.objects
for delete to authenticated using (
  bucket_id = 'customer-valid-ids' and (storage.foldername(name))[1] = auth.uid()::text
);

-- The storage bucket intentionally has no SELECT policy. Signed URLs are
-- issued only by the role-checking review-customer-id Edge Function.
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
  end if;
  if auth.uid() is not null and (
     new.valid_id_front_path is distinct from old.valid_id_front_path
     or new.valid_id_back_path is distinct from old.valid_id_back_path
  ) then
    new.valid_id_status := case when new.valid_id_front_path is null and new.valid_id_back_path is null then 'none' else 'unchecked' end;
    new.valid_id_review_note := null;
    new.valid_id_reviewed_at := null;
    new.valid_id_scan_note := null;
  end if;
  return new;
end;
$$;
drop trigger if exists reset_valid_id_review_on_upload on public.profiles;
create trigger reset_valid_id_review_on_upload before insert or update
on public.profiles for each row execute function public.reset_valid_id_review_on_upload();

notify pgrst, 'reload schema';
