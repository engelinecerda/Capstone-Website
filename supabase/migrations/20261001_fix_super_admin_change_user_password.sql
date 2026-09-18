-- Fix "Users & Roles" → Edit User → Security tab: force-setting a password
-- for a manager/staff account fails with
--   "Profile saved but password update failed: Forbidden. Only super
--    admins can change passwords."
-- for every Admin, even though the same Admin can already save that same
-- account's name/role/staff-role fine (those go through a normal
-- `profiles` UPDATE, gated by the "admin manage profiles" RLS policy —
-- see 20260714_admin_manager_separation_of_duties.sql). Only the password
-- path, which goes through this RPC instead of RLS, was broken.
--
-- public.super_admin_change_user_password(target_user_id, new_password) is
-- called from js/super_admin_accounts.js but was never captured in this
-- migrations folder — it only exists as a hand-applied function in the live
-- project (see CLAUDE.md: "Database Migrations ... applied manually in the
-- Supabase SQL Editor"). Re-declaring it here, matching the exact
-- (target_user_id uuid, new_password text) signature and the
-- {success, error} jsonb shape the frontend already expects, and gating it
-- the same way every other privileged write in this project is gated:
-- get_my_role() = 'admin' (20260624_rename_roles_admin_to_manager.sql),
-- the same check used by protect_privileged_profile_fields()
-- (20260812_protect_privileged_profile_fields.sql). If the live function's
-- previous check was written differently (e.g. checking the wrong JWT
-- claim), running this migration replaces it outright.
--
-- Also closes a gap while we're in here: this RPC writes
-- auth.users.encrypted_password directly instead of going through
-- supabase.auth.updateUser(), so Supabase Auth's own configured password
-- policy never runs for an admin-forced reset. Re-validating server-side
-- with the same rules as js/password_rules.js's validatePassword() (used by
-- signup, account, reset-password, and now this Security tab and the
-- portal set/reset-password pages too) so this path can't be used to set a
-- password weaker than every other entry point in the app allows.
--
-- trg_notify_on_password_changed (20260830_password_changed_notification.sql)
-- already fires on any UPDATE to auth.users.encrypted_password and emails
-- the account owner — no separate notification needed here.
--
-- Assumes pgcrypto is enabled in the `extensions` schema, which is the
-- Supabase default (Database → Extensions). If your project has it
-- installed elsewhere, adjust the `extensions.crypt` / `extensions.gen_salt`
-- calls below to match.
-- ─────────────────────────────────────────────────────────────────────────────

-- The live function's return type isn't known ahead of time (it's not in
-- this repo's migrations — see note above), and Postgres refuses to change
-- a function's return type via CREATE OR REPLACE. Drop it first so this
-- migration applies cleanly regardless of what it currently returns.
drop function if exists public.super_admin_change_user_password(uuid, text);

create or replace function public.super_admin_change_user_password(
  target_user_id uuid,
  new_password text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_updated_id uuid;
begin
  if public.get_my_role() <> 'admin' then
    raise exception 'Forbidden. Only admins can change passwords.';
  end if;

  if new_password is null or length(new_password) < 8 then
    raise exception 'Password must be at least 8 characters long.';
  elsif new_password !~ '[a-z]' then
    raise exception 'Password must include at least one lowercase letter.';
  elsif new_password !~ '[A-Z]' then
    raise exception 'Password must include at least one uppercase letter.';
  elsif new_password !~ '[^A-Za-z0-9]' then
    raise exception 'Password must include at least one special character.';
  end if;

  update auth.users
     set encrypted_password = extensions.crypt(new_password, extensions.gen_salt('bf')),
         updated_at = now()
   where id = target_user_id
  returning id into v_updated_id;

  if v_updated_id is null then
    raise exception 'Account not found.';
  end if;

  return jsonb_build_object('success', true);
end;
$$;

revoke all on function public.super_admin_change_user_password(uuid, text) from public;
grant execute on function public.super_admin_change_user_password(uuid, text) to authenticated;
