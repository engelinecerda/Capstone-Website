-- Login-attempt limiting for every account type (customer, staff, manager,
-- admin), sharing ONE mechanism.
--
-- CORRECTED PREMISE: the customer side had no lockout at all
-- (js/login_signup.js just called signInWithPassword with no tracking).
-- The admin side had public.admin_login_failure_tracking +
-- record_failed_admin_login() (20260820_admin_notification_scoping.sql),
-- but on inspection that mechanism only ever sent an admin a notification
-- after 5 failures — it never actually rejected a subsequent correct
-- password. Neither side had a real, enforced lock. This migration builds
-- one, generalizes the existing admin-only tracking table to cover every
-- role instead of adding a second system, and applies it everywhere.
--
-- THE REAL ENFORCEMENT BOUNDARY is section 7 below (a Supabase Auth
-- "Password Verification Attempt" hook) — it runs inside GoTrue itself,
-- after the password has been confirmed correct but before a session is
-- issued, so a correct password cannot bypass an active lock and the lock
-- cannot be skipped by calling the Auth API directly instead of going
-- through our own RPCs. That hook function does nothing until enabled in
-- the Supabase Dashboard (Authentication -> Hooks) — see the comment
-- above section 7 for the exact one-time manual step.
-- ─────────────────────────────────────────────────────────────────────────────

-- ═══════════════════════════════════════════════════════════════════════════
-- 1. Generalize the existing admin-only table to every role
-- ═══════════════════════════════════════════════════════════════════════════
alter table public.admin_login_failure_tracking rename to login_failure_tracking;
alter table public.login_failure_tracking add column if not exists locked_until timestamptz;

comment on table public.login_failure_tracking is
  'Shared failed-login tracking for every account type (customer, staff, manager, admin) — one row per user_id, one mechanism for the whole app. No attempted passwords are ever stored.';

-- ═══════════════════════════════════════════════════════════════════════════
-- 2. IP-based rate limiting — best-effort, NOT hook-enforced
-- ═══════════════════════════════════════════════════════════════════════════
-- The Password Verification Attempt hook payload is only { user_id, valid }
-- (confirmed against Supabase's docs) — it has no access to the caller's
-- IP, so IP throttling can only live at the RPC layer below, which is only
-- as strong as the client actually calling it. That's a materially weaker
-- guarantee than the account-level lock (section 7), which is why account
-- lock is the primary defense and this is defense-in-depth against one
-- source spraying many different emails from the real login form — not a
-- claim that it survives someone hitting the raw Auth REST API directly.
create table if not exists public.login_ip_failure_tracking (
  ip                inet primary key,
  failure_count     int not null default 0,
  window_started_at timestamptz not null default now(),
  locked_until      timestamptz
);
alter table public.login_ip_failure_tracking enable row level security;
-- No policies — only the SECURITY DEFINER functions below touch this table.

-- Best-effort extraction of the real client IP from the X-Forwarded-For
-- header PostgREST exposes via request.headers. Proxies append to this
-- list left-to-right from the original client, so the first entry is what
-- we want. Never errors — returns null and IP throttling just no-ops if
-- unavailable; account-level locking does not depend on this.
create or replace function public._client_ip()
returns inet
language plpgsql
stable
as $$
declare
  v_headers jsonb;
  v_xff text;
begin
  v_headers := nullif(current_setting('request.headers', true), '')::jsonb;
  v_xff := v_headers ->> 'x-forwarded-for';
  if v_xff is null or v_xff = '' then
    return null;
  end if;
  return trim(split_part(v_xff, ',', 1))::inet;
exception when others then
  return null;
end;
$$;

-- ═══════════════════════════════════════════════════════════════════════════
-- 3. record_failed_login — generalized from record_failed_admin_login()
-- ═══════════════════════════════════════════════════════════════════════════
-- Called anonymously right after any failed signInWithPassword (customer,
-- board/staff, or admin/manager login). Like the function it replaces,
-- must never reveal whether p_email belongs to a real account — same
-- response shape either way for an unknown email.
--
-- Thresholds: 5 failed attempts within a 15-minute window locks the
-- account for 10 minutes — matches the ~5/~10-minute figures this was
-- scoped against, and reuses the admin side's existing 5/15 window rather
-- than inventing new numbers. The shared staff/board tablet account is the
-- one exception: role = 'staff' gets a threshold of 10, since it's one
-- credential used by many different people and mistyping is more likely —
-- see the "shared staff account" note in section 6 for its recovery path.
drop function if exists public.record_failed_admin_login(text);

create or replace function public.record_failed_login(p_email text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id      uuid;
  v_role         text;
  v_row          public.login_failure_tracking%rowtype;
  v_threshold    int;
  v_window       constant interval := interval '15 minutes';
  v_lock_for     constant interval := interval '10 minutes';
  v_ip           inet;
  v_ip_row       public.login_ip_failure_tracking%rowtype;
  v_ip_threshold constant int := 20;
  v_just_locked  boolean := false;
begin
  -- IP-side counter is independent of whether p_email matches a real
  -- account — this is what catches one source spraying many different
  -- emails, which the per-account counter below can't see on its own.
  v_ip := public._client_ip();
  if v_ip is not null then
    select * into v_ip_row from public.login_ip_failure_tracking where ip = v_ip;
    if not found then
      insert into public.login_ip_failure_tracking (ip, failure_count, window_started_at)
      values (v_ip, 1, now());
    elsif v_ip_row.window_started_at < now() - v_window then
      update public.login_ip_failure_tracking
      set failure_count = 1, window_started_at = now(), locked_until = null
      where ip = v_ip;
    else
      update public.login_ip_failure_tracking
      set failure_count = failure_count + 1
      where ip = v_ip
      returning * into v_ip_row;
      if v_ip_row.failure_count >= v_ip_threshold and v_ip_row.locked_until is null then
        update public.login_ip_failure_tracking set locked_until = now() + v_lock_for where ip = v_ip;
      end if;
    end if;
  end if;

  select user_id, role into v_user_id, v_role
  from public.profiles
  where email = lower(trim(p_email));

  if v_user_id is null then
    return jsonb_build_object('locked', false);
  end if;

  v_threshold := case when v_role = 'staff' then 10 else 5 end;

  select * into v_row from public.login_failure_tracking where user_id = v_user_id;

  if not found then
    insert into public.login_failure_tracking (user_id, failure_count, window_started_at)
    values (v_user_id, 1, now());
    return jsonb_build_object('locked', false);
  end if;

  -- An already-active lock always wins over the window/count bookkeeping.
  if v_row.locked_until is not null and v_row.locked_until > now() then
    return jsonb_build_object('locked', true, 'locked_until', v_row.locked_until);
  end if;

  if v_row.window_started_at is null or now() - v_row.window_started_at > v_window then
    update public.login_failure_tracking
    set failure_count = 1, window_started_at = now(), locked_until = null
    where user_id = v_user_id;
    return jsonb_build_object('locked', false);
  end if;

  update public.login_failure_tracking
  set failure_count = failure_count + 1
  where user_id = v_user_id
  returning * into v_row;

  if v_row.failure_count >= v_threshold and v_row.locked_until is null then
    update public.login_failure_tracking
    set locked_until = now() + v_lock_for
    where user_id = v_user_id
    returning * into v_row;
    v_just_locked := true;
  end if;

  if v_just_locked then
    insert into public.audit_log (user_id, user_name, user_role, action, category, details, entity_id)
    select v_user_id,
           trim(coalesce(first_name,'') || ' ' || coalesce(last_name,'')),
           role,
           'Account Locked (Failed Logins)',
           'security',
           v_threshold::text || ' failed sign-in attempts within 15 minutes. Locked for 10 minutes.' ||
             case when v_ip is not null then ' Source IP: ' || v_ip::text else '' end,
           v_user_id::text
    from public.profiles where user_id = v_user_id;

    if v_role in ('manager', 'admin') then
      perform public._notify_admins_internal(
        'admin_login_security_alert',
        'Account locked after repeated failed logins',
        v_threshold::text || ' failed sign-in attempts locked this account for 10 minutes. If this was not the account holder, review it.',
        '/admin/super%20admin/super_admin_accounts.html'
      );
    end if;
  end if;

  return jsonb_build_object('locked', v_just_locked, 'locked_until', v_row.locked_until);
end;
$$;

grant execute on function public.record_failed_login(text) to anon, authenticated;

-- ═══════════════════════════════════════════════════════════════════════════
-- 4. check_login_lock — anonymous pre-check, UX only (not the boundary)
-- ═══════════════════════════════════════════════════════════════════════════
-- Lets the login form show "try again in X minutes" immediately, without
-- spending a real Auth call first. Skipping this changes nothing about
-- security — the hook in section 7 still rejects the login either way.
create or replace function public.check_login_lock(p_email text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id      uuid;
  v_locked_until timestamptz;
begin
  select user_id into v_user_id from public.profiles where email = lower(trim(p_email));
  if v_user_id is null then
    return jsonb_build_object('locked', false);
  end if;

  select locked_until into v_locked_until
  from public.login_failure_tracking
  where user_id = v_user_id;

  if v_locked_until is not null and v_locked_until > now() then
    return jsonb_build_object('locked', true, 'locked_until', v_locked_until);
  end if;

  return jsonb_build_object('locked', false);
end;
$$;

grant execute on function public.check_login_lock(text) to anon, authenticated;

-- ═══════════════════════════════════════════════════════════════════════════
-- 5. clear_my_login_failures — unchanged behavior, now against the
--    renamed/shared table (already role-agnostic: scoped to auth.uid()).
-- ═══════════════════════════════════════════════════════════════════════════
create or replace function public.clear_my_login_failures()
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    return;
  end if;
  update public.login_failure_tracking
  set failure_count = 0, window_started_at = null, locked_until = null
  where user_id = auth.uid();
end;
$$;

grant execute on function public.clear_my_login_failures() to authenticated;

-- ═══════════════════════════════════════════════════════════════════════════
-- 6. admin_clear_login_lock — the shared staff/board account's recovery
--    path (and generally useful for any locked account)
-- ═══════════════════════════════════════════════════════════════════════════
-- The staff login is one credential shared by the whole café floor on one
-- tablet — locking it locks out everyone until an Admin can act, so
-- "recoverable by an Admin without waiting the full cooldown" is not
-- optional for that account. This works for any account, but it's the
-- staff account's actual unlock path.
create or replace function public.admin_clear_login_lock(p_user_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_target_email text;
begin
  if public.get_my_role() <> 'admin' then
    raise exception 'Only an admin can clear a login lock.';
  end if;

  select email into v_target_email from public.profiles where user_id = p_user_id;

  update public.login_failure_tracking
  set failure_count = 0, window_started_at = null, locked_until = null
  where user_id = p_user_id;

  insert into public.audit_log (user_id, user_name, user_role, action, category, details, entity_id)
  select auth.uid(),
         trim(coalesce(p.first_name,'') || ' ' || coalesce(p.last_name,'')),
         p.role,
         'Cleared Login Lock',
         'security',
         'Manually cleared a login lockout for ' || coalesce(v_target_email, p_user_id::text) || '.',
         p_user_id::text
  from public.profiles p where p.user_id = auth.uid();
end;
$$;

grant execute on function public.admin_clear_login_lock(uuid) to authenticated;

-- ═══════════════════════════════════════════════════════════════════════════
-- 7. THE REAL ENFORCEMENT BOUNDARY — Auth "Password Verification Attempt"
--    hook. Runs inside GoTrue itself, after the password is confirmed
--    correct but before a session is issued — this is what makes a
--    correct password unable to bypass an active lock, and what makes the
--    lock unbypassable by calling the Auth REST API directly instead of
--    going through record_failed_login above (which only ever runs from
--    our own client-side JS, so a raw API call could otherwise skip it
--    entirely).
--
--    THIS FUNCTION DOES NOTHING UNTIL YOU ENABLE IT — one manual step,
--    cannot be done from a migration:
--      Supabase Dashboard -> your project -> Authentication -> Hooks
--      -> "Password Verification Attempt" -> Enable -> Postgres function
--      -> select public.hook_password_verification_attempt -> Save.
-- ═══════════════════════════════════════════════════════════════════════════
create or replace function public.hook_password_verification_attempt(event jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id      uuid;
  v_locked_until timestamptz;
  v_minutes_left int;
begin
  v_user_id := (event ->> 'user_id')::uuid;
  if v_user_id is null then
    return jsonb_build_object('decision', 'continue');
  end if;

  select locked_until into v_locked_until
  from public.login_failure_tracking
  where user_id = v_user_id;

  if v_locked_until is null or v_locked_until <= now() then
    return jsonb_build_object('decision', 'continue');
  end if;

  v_minutes_left := greatest(1, ceil(extract(epoch from (v_locked_until - now())) / 60)::int);

  return jsonb_build_object(
    'decision', 'reject',
    'message', 'Too many failed attempts. Try again in ' || v_minutes_left ||
               ' minute' || case when v_minutes_left = 1 then '' else 's' end || '.'
  );
end;
$$;

grant execute on function public.hook_password_verification_attempt(jsonb) to supabase_auth_admin;
revoke execute on function public.hook_password_verification_attempt(jsonb) from authenticated, anon, public;

grant all on table public.login_failure_tracking to supabase_auth_admin;
revoke all on table public.login_failure_tracking from authenticated, anon, public;

-- Verify with (run as separate queries):
--   select proname from pg_proc where proname in
--     ('record_failed_login','check_login_lock','clear_my_login_failures',
--      'admin_clear_login_lock','hook_password_verification_attempt');
--   select * from public.login_failure_tracking limit 5;
