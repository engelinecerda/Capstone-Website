-- Fix: "Never signed in" always showing for active accounts.
--
-- js/super_admin_accounts.js reads profiles.last_sign_in_at, but that
-- column never existed (confirmed: no prior migration creates it) and
-- nothing ever wrote to it. Supabase Auth already maintains the real value
-- on auth.users.last_sign_in_at automatically on every successful sign-in —
-- this migration adds the missing column and keeps it in sync via a
-- database trigger, mirroring the existing on_auth_user_created pattern
-- in 20260401_create_profiles.sql. A trigger is used (not a client-side
-- write) so it can't be skipped or spoofed by app code.

alter table public.profiles
  add column if not exists last_sign_in_at timestamptz;

create or replace function public.sync_profile_last_sign_in()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.profiles
  set last_sign_in_at = new.last_sign_in_at
  where user_id = new.id;

  return new;
end;
$$;

drop trigger if exists on_auth_user_sign_in on auth.users;
create trigger on_auth_user_sign_in
  after update on auth.users
  for each row
  when (new.last_sign_in_at is distinct from old.last_sign_in_at)
  execute function public.sync_profile_last_sign_in();

-- One-time backfill so already-active accounts (e.g. today's Admin and
-- Manager) show correctly right away instead of waiting for their next
-- login.
update public.profiles p
set last_sign_in_at = u.last_sign_in_at
from auth.users u
where u.id = p.user_id
  and u.last_sign_in_at is not null
  and p.last_sign_in_at is null;
