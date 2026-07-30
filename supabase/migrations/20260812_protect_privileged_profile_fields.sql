-- Close a self-promotion gap found while fixing the last-admin guard bug.
--
-- "update own profile" (20260401_create_profiles.sql) has no WITH CHECK, so
-- Postgres implicitly reuses its USING clause (auth.uid() = user_id) as the
-- check too — that only verifies the row still belongs to the caller, not
-- which columns they changed. Combined with "admin manage profiles"
-- (20260714_admin_manager_separation_of_duties.sql) being OR'd in as a
-- second permissive UPDATE policy, any authenticated user can currently run
-- `update profiles set role = 'admin' where user_id = auth.uid()` directly
-- and it passes RLS — protect_last_admin() only guards against losing the
-- last admin, it does nothing to stop new, unauthorized promotions.
--
-- Fixed at the trigger layer (not by rewriting the RLS policy) so it can't
-- be bypassed by whichever policy happens to admit the row, matching this
-- project's existing DB-first enforcement pattern (protect_last_admin,
-- 20260803_last_admin_guard.sql). Scoped to role/is_locked/staff_role only
-- — the three privilege-relevant columns; everything else (name, email,
-- phone) stays freely self-editable as before.

create or replace function public.protect_privileged_profile_fields()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.role is not distinct from old.role
     and new.is_locked is not distinct from old.is_locked
     and new.staff_role is not distinct from old.staff_role then
    return new;
  end if;

  -- get_my_role() resolves to NULL for service-role callers (no auth.uid()),
  -- e.g. the create-staff-account edge function — NULL <> 'admin' is NULL,
  -- which plpgsql's IF treats as false, so those legitimate writes pass
  -- through unaffected. Only an authenticated non-admin session is blocked.
  if public.get_my_role() <> 'admin' then
    raise exception 'Only an admin can change role, lock state, or staff role.';
  end if;

  return new;
end;
$$;

drop trigger if exists trg_protect_privileged_profile_fields on public.profiles;
create trigger trg_protect_privileged_profile_fields
  before update on public.profiles
  for each row
  execute function public.protect_privileged_profile_fields();
