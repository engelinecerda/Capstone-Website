-- Staff login separation: block self-service password reset for the shared
-- staff/board account server-side, so a crafted request that reaches
-- auth.updateUser() directly (bypassing the UI, which no longer offers a
-- "Forgot password?" link on the staff login page) still can't change it.
--
-- The only legitimate way this password changes is the admin-only
-- reset-board-password edge function, which now opens a short allowance
-- window on the profile immediately before calling
-- supabaseAdmin.auth.admin.updateUserById().

alter table public.profiles
  add column if not exists staff_password_reset_allowed_until timestamptz;

create or replace function public.guard_staff_password_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_role text;
  v_allowed_until timestamptz;
begin
  select role, staff_password_reset_allowed_until
    into v_role, v_allowed_until
  from public.profiles
  where user_id = new.id;

  if v_role = 'staff' and (v_allowed_until is null or v_allowed_until < now()) then
    raise exception 'The shared staff password is managed by the admin.';
  end if;

  return new;
end;
$$;

drop trigger if exists guard_staff_password_change on auth.users;
create trigger guard_staff_password_change
  before update of encrypted_password on auth.users
  for each row
  when (new.encrypted_password is distinct from old.encrypted_password)
  execute function public.guard_staff_password_change();
