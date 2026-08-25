-- Admin notifications: stop the config-only Admin role from receiving the
-- Manager's operational alerts, and give Admin its own notification set
-- scoped to accounts/security/backup/settings (Model B role separation).
--
-- ═══════════════════════════════════════════════════════════════════════════
-- ROOT CAUSE OF THE LEAK
-- ═══════════════════════════════════════════════════════════════════════════
-- notify_admins_on_reservation() was correctly fixed to target role =
-- 'manager' in 20260712_personalize_notifications.sql. But
-- 20260808_notification_config.sql's rewrite of the same function (needed to
-- add the new reservation_submitted customer dispatch alongside it) was based
-- off the original 20260513 version instead of the 712 one, silently
-- reverting the recipient to role IN ('admin', 'super_admin') — its own
-- comment even says the admin clause was "preserved byte-for-byte... not this
-- migration's job to fix." 20260818_flagged_fixes.sql later dropped the dead
-- 'super_admin' half of that OR-clause but left 'admin' in place — so today,
-- "New reservation submitted" and "Cancellation requested" alerts go to the
-- Admin (config-only role) instead of the Manager (operational role).
--
-- The other three operational alert functions — notify_on_contract_review,
-- notify_admins_on_new_payment, notify_manager_on_reschedule_request — were
-- never touched after 20260712 and are already Manager-only. No change
-- needed there; only notify_admins_on_reservation() is fixed below, and only
-- its recipient role changes (both branches' text/logic are otherwise
-- byte-identical to the current live version).
-- ═══════════════════════════════════════════════════════════════════════════

create or replace function public.notify_admins_on_reservation()
returns trigger language plpgsql security definer as $$
declare
  v_merge_data jsonb;
begin
  if TG_OP = 'INSERT' then
    insert into notifications (user_id, type, title, body, link)
    select user_id,
           'admin_new_reservation',
           'New Reservation Submitted',
           'A customer has submitted a new reservation awaiting your review.',
           '/admin/reservations.html'
    from profiles where role = 'manager';

    v_merge_data := public.build_notification_merge_data(NEW.reservation_id);
    perform public.dispatch_notification(NEW.user_id, 'reservation_submitted', 'reservation_status', '/account.html', v_merge_data);

  elsif TG_OP = 'UPDATE'
    and NEW.status = 'cancellation_requested'
    and (OLD.status is distinct from 'cancellation_requested') then
    insert into notifications (user_id, type, title, body, link)
    select user_id,
           'admin_cancellation_request',
           'Cancellation Requested',
           'A customer has submitted a cancellation request for their reservation.',
           '/admin/reservations.html'
    from profiles where role = 'manager';
  end if;

  return NEW;
end;
$$;

-- ═══════════════════════════════════════════════════════════════════════════
-- STALE RLS POLICY CLEANUP
-- ═══════════════════════════════════════════════════════════════════════════
-- 'super_admin' has not been a role value since 20260624_rename_roles_admin_
-- to_manager.sql; harmless (every notification insert below goes through a
-- SECURITY DEFINER function, which bypasses RLS regardless) but worth closing
-- while touching this area, matching the same kind of stale-role cleanup
-- already done in 20260818_flagged_fixes.sql for a different function.
drop policy if exists "admins_insert_notifications" on public.notifications;
create policy "admins_insert_notifications" on public.notifications for insert with check (
  exists (select 1 from public.profiles where user_id = auth.uid() and role = 'admin')
);

-- ═══════════════════════════════════════════════════════════════════════════
-- SHARED BROADCAST HELPERS
-- ═══════════════════════════════════════════════════════════════════════════

-- Internal helper — deliberately NOT granted to anon/authenticated, so it can
-- never be called directly over PostgREST. Used only from other SECURITY
-- DEFINER functions/triggers below, where type/title/body/link are always
-- built from server-side data, never raw end-user input.
create or replace function public._notify_admins_internal(
  p_type  text,
  p_title text,
  p_body  text,
  p_link  text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.notifications (user_id, type, title, body, link)
  select user_id, p_type, p_title, p_body, p_link
  from public.profiles
  where role = 'admin';
end;
$$;

-- Public-facing wrapper — the only one meant to be invoked directly over
-- PostgREST (used by js/super_admin_backup.js's backup-completed/backup-
-- failed calls, and the reset-board-password edge function). Guards against
-- a non-admin authenticated client calling this RPC directly with arbitrary
-- title/body text. Service-role callers (edge functions) have no auth.uid(),
-- so get_my_role() resolves NULL here — NULL <> 'admin' is NULL, which
-- plpgsql's IF treats as false, so those calls pass through unaffected (same
-- idiom as protect_privileged_profile_fields(), 20260812).
create or replace function public.notify_admins(
  p_type  text,
  p_title text,
  p_body  text,
  p_link  text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if public.get_my_role() <> 'admin' then
    raise exception 'Only an admin can trigger an admin notification.';
  end if;
  perform public._notify_admins_internal(p_type, p_title, p_body, p_link);
end;
$$;

grant execute on function public.notify_admins(text, text, text, text) to authenticated;

-- ═══════════════════════════════════════════════════════════════════════════
-- 3.2 ACCOUNT / SECURITY — account created, role changed (profiles)
-- ═══════════════════════════════════════════════════════════════════════════
-- Customer signups (role defaults to 'customer' in handle_new_user(),
-- 20260401_create_profiles.sql) are filtered out — not an "account/security"
-- event in the Admin's domain, and would otherwise fire on every public
-- signup.
create or replace function public.notify_admin_on_account_created()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if NEW.role = 'customer' then
    return NEW;
  end if;

  perform public._notify_admins_internal(
    'admin_account_created',
    'New account created',
    trim(coalesce(NEW.first_name, '') || ' ' || coalesce(NEW.last_name, '')) || ' (' || NEW.email || ') was added as ' || NEW.role || '.',
    '/admin/super%20admin/super_admin_accounts.html'
  );
  return NEW;
end;
$$;

drop trigger if exists trg_notify_admin_account_created on public.profiles;
create trigger trg_notify_admin_account_created
  after insert on public.profiles
  for each row execute function public.notify_admin_on_account_created();

-- "UPDATE OF role" fires whenever an UPDATE statement's SET list mentions
-- role at all (e.g. js/super_admin_accounts.js's saveAccountUpdate() always
-- includes it, changed or not) — the NEW.role IS NOT DISTINCT FROM OLD.role
-- guard is what actually restricts this to genuine changes.
create or replace function public.notify_admin_on_role_changed()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if NEW.role is not distinct from OLD.role then
    return NEW;
  end if;

  perform public._notify_admins_internal(
    'admin_account_role_changed',
    'Account role changed',
    trim(coalesce(NEW.first_name, '') || ' ' || coalesce(NEW.last_name, '')) || ': ' || coalesce(OLD.role, 'none') || ' -> ' || NEW.role || '.',
    '/admin/super%20admin/super_admin_accounts.html'
  );
  return NEW;
end;
$$;

drop trigger if exists trg_notify_admin_role_changed on public.profiles;
create trigger trg_notify_admin_role_changed
  after update of role on public.profiles
  for each row execute function public.notify_admin_on_role_changed();

-- ═══════════════════════════════════════════════════════════════════════════
-- 3.3 SYSTEM SETTINGS CHANGED (system_settings)
-- ═══════════════════════════════════════════════════════════════════════════
-- Excludes last_backup_at — that key is bookkeeping written by the backup
-- flow itself (js/super_admin_backup.js), already covered by its own
-- explicit "Backup completed" notification below; alerting on it here too
-- would just be a confusing duplicate for the same event.
create or replace function public.notify_admin_on_setting_changed()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if NEW.setting_key = 'last_backup_at' then
    return NEW;
  end if;
  if NEW.setting_value is not distinct from OLD.setting_value then
    return NEW;
  end if;

  perform public._notify_admins_internal(
    'admin_setting_changed',
    'System setting changed',
    'The "' || NEW.setting_key || '" setting was updated.',
    case NEW.setting_key
      when 'payment_rules'             then '/admin/config/payment-options.html'
      when 'reservation_rules'         then '/admin/config/form.html'
      when 'terms_and_conditions'      then '/admin/config/form.html'
      when 'data_privacy_policy'       then '/admin/config/form.html'
      when 'reservation_form_fields'   then '/admin/config/form.html'
      when 'backup_retention_days'     then '/admin/super%20admin/super_admin_backup.html'
      else null
    end
  );
  return NEW;
end;
$$;

drop trigger if exists trg_notify_admin_setting_changed on public.system_settings;
create trigger trg_notify_admin_setting_changed
  after update on public.system_settings
  for each row execute function public.notify_admin_on_setting_changed();

-- ═══════════════════════════════════════════════════════════════════════════
-- 3.4 REPEATED FAILED LOGIN ON AN ADMIN ACCOUNT (security alert)
-- ═══════════════════════════════════════════════════════════════════════════
-- One row per user, a rolling window + counter — never a row-per-attempt
-- log, and never stores the attempted password. There is nothing here worth
-- reading even with SELECT access (which no one has; see RLS below).
create table if not exists public.admin_login_failure_tracking (
  user_id           uuid primary key references auth.users(id) on delete cascade,
  failure_count     int not null default 0,
  window_started_at timestamptz,
  last_alerted_at   timestamptz
);

alter table public.admin_login_failure_tracking enable row level security;
-- No policies at all — every access goes through the two SECURITY DEFINER
-- functions below, which bypass RLS. Direct client access is fully denied.

-- Threshold: 5 failures within a 15-minute rolling window. Tune here only.
-- Called anonymously (the caller has, by definition, just failed to log in),
-- so it must never reveal whether p_email belongs to an admin account —
-- looked up silently, no-op on no match, same response either way.
create or replace function public.record_failed_admin_login(p_email text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id   uuid;
  v_row       public.admin_login_failure_tracking%rowtype;
  v_threshold constant int := 5;
  v_window    constant interval := interval '15 minutes';
begin
  select user_id into v_user_id
  from public.profiles
  where email = lower(trim(p_email)) and role = 'admin';

  if v_user_id is null then
    return;
  end if;

  select * into v_row from public.admin_login_failure_tracking where user_id = v_user_id;

  if not found then
    insert into public.admin_login_failure_tracking (user_id, failure_count, window_started_at)
    values (v_user_id, 1, now());
    return;
  end if;

  if v_row.window_started_at is null or now() - v_row.window_started_at > v_window then
    update public.admin_login_failure_tracking
    set failure_count = 1, window_started_at = now()
    where user_id = v_user_id;
    return;
  end if;

  update public.admin_login_failure_tracking
  set failure_count = failure_count + 1
  where user_id = v_user_id
  returning * into v_row;

  if v_row.failure_count >= v_threshold
     and (v_row.last_alerted_at is null or v_row.last_alerted_at < v_row.window_started_at) then
    perform public._notify_admins_internal(
      'admin_login_security_alert',
      'Repeated failed login attempts',
      v_threshold::text || ' failed sign-in attempts were made on an admin account within 15 minutes. If this was not the account holder, consider locking the account.',
      '/admin/super%20admin/super_admin_accounts.html'
    );
    update public.admin_login_failure_tracking set last_alerted_at = now() where user_id = v_user_id;
  end if;
end;
$$;

grant execute on function public.record_failed_admin_login(text) to anon, authenticated;

-- Clears the caller's own counter on a successful login. Authenticated-only
-- (the caller must actually have a session by the time this is called) and
-- scoped to auth.uid() — cannot be used to clear anyone else's counter.
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
  update public.admin_login_failure_tracking
  set failure_count = 0, window_started_at = null
  where user_id = auth.uid();
end;
$$;

grant execute on function public.clear_my_login_failures() to authenticated;