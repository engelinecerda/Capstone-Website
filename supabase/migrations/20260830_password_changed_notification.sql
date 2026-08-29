-- Self-service password reset (Admin & Manager) — completion notification.
--
-- Requirement: after any password change on an Admin/Manager account, email
-- that account "your password was changed" as a tripwire — if the owner
-- didn't do it, that's their signal something is wrong. Fires on ANY write
-- to auth.users.encrypted_password, not just self-service resets: an admin-
-- forced reset (super_admin_change_user_password, used from Users & Roles)
-- changes the same column, and the account owner should be told about that
-- too — that's the actual security value here, not just the self-service
-- case. Scoped to role IN ('admin','manager') only, matching this prompt's
-- explicit boundary — never fires for customers, individual staff, or the
-- shared board account (auth.users is shared across the whole project, so
-- an unscoped trigger would incorrectly email customers on their own
-- password changes too).
--
-- Plain direct insert into notifications (channel='email', status='pending'),
-- same as every other admin_*/security_* alert in this codebase — not routed
-- through the notification_template/dispatch_notification system, which is
-- reserved for the 6 catalogued customer-facing triggers
-- (20260808_notification_config.sql). send-notification-email already picks
-- up any channel='email' row regardless of source and updates status to
-- sent/failed after the actual send attempt.
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function public.notify_on_password_changed()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_role text;
begin
  if NEW.encrypted_password is not distinct from OLD.encrypted_password then
    return NEW;
  end if;

  select role into v_role from public.profiles where user_id = NEW.id;
  if v_role not in ('admin', 'manager') then
    return NEW;
  end if;

  insert into public.notifications (user_id, type, title, body, link, channel, status)
  values (
    NEW.id,
    'security_password_changed',
    'Your password was changed',
    'The password for your ELI Coffee Events portal account was just changed. If this was not you, contact the Admin immediately.',
    null,
    'email',
    'pending'
  );

  return NEW;
end;
$$;

drop trigger if exists trg_notify_on_password_changed on auth.users;
create trigger trg_notify_on_password_changed
  after update of encrypted_password on auth.users
  for each row execute function public.notify_on_password_changed();
