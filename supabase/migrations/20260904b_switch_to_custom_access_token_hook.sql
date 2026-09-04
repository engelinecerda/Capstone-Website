-- Corrects 20260904_login_lockout_enforcement.sql's enforcement hook: the
-- "Password Verification Attempt" hook it was written for turned out to be
-- gated behind Supabase's Team/Enterprise plan (confirmed directly in the
-- project's own Dashboard — Authentication -> Auth Hooks lists it under
-- "Team or Enterprise Plan required", grayed out). Not available here.
--
-- Switching the enforcement point to the "Customize Access Token (JWT)
-- Claims" hook instead — visible and usable on this project's plan. It
-- fires later in the flow (once GoTrue has already confirmed the password
-- is correct and is about to mint a session/JWT) but can still abort the
-- whole sign-in: returning {"error": {"http_code": ..., "message": ...}}
-- instead of {"claims": ...} stops token issuance, so the practical
-- guarantee is the same — a correct password still cannot produce a
-- session while the account is locked, enforced server-side, unbypassable
-- by calling the Auth API directly. Verified this hook's input/output
-- shape and rejection mechanism against Supabase's own docs before writing
-- this, the same way the previous (unusable) hook was verified.
--
-- Still requires the same one-time manual step, just against a different
-- hook: Dashboard -> Authentication -> Auth Hooks -> Customize Access
-- Token (JWT) Claims hook -> Enable -> Postgres function -> select
-- public.hook_custom_access_token -> Save.
-- ─────────────────────────────────────────────────────────────────────────────

drop function if exists public.hook_password_verification_attempt(jsonb);

create or replace function public.hook_custom_access_token(event jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id      uuid;
  v_locked_until timestamptz;
  v_minutes_left int;
  v_claims       jsonb;
begin
  v_user_id := (event ->> 'user_id')::uuid;
  v_claims  := event -> 'claims';

  if v_user_id is null then
    return jsonb_build_object('claims', v_claims);
  end if;

  select locked_until into v_locked_until
  from public.login_failure_tracking
  where user_id = v_user_id;

  if v_locked_until is null or v_locked_until <= now() then
    -- Not locked — pass the claims through unmodified. This hook's job
    -- here is only to veto, never to add/change claims.
    return jsonb_build_object('claims', v_claims);
  end if;

  v_minutes_left := greatest(1, ceil(extract(epoch from (v_locked_until - now())) / 60)::int);

  return jsonb_build_object(
    'error', jsonb_build_object(
      'http_code', 403,
      'message', 'Too many failed attempts. Try again in ' || v_minutes_left ||
                 ' minute' || case when v_minutes_left = 1 then '' else 's' end || '.'
    )
  );
end;
$$;

grant execute on function public.hook_custom_access_token(jsonb) to supabase_auth_admin;
revoke execute on function public.hook_custom_access_token(jsonb) from authenticated, anon, public;

-- login_failure_tracking's grants to supabase_auth_admin / revoke from
-- authenticated,anon,public were already set in 20260904 for the old hook
-- function's sake — unchanged and still correct, this hook reads the same
-- table.

-- Verify with (run as separate queries):
--   select proname from pg_proc where proname = 'hook_custom_access_token';
--   select proname from pg_proc where proname = 'hook_password_verification_attempt'; -- should return no rows
