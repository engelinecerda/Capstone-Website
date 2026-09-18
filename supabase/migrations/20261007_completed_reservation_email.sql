-- BUG-05 (Medium): system fails to dispatch an automated confirmation
-- email when a reservation is marked "Completed".
--
-- Root cause: reservations.status = 'completed' IS reliably set server-side
-- today (the complete_past_reservations() pg_cron job, every 15 minutes,
-- 20260930b_auto_complete_past_reservations.sql) and DOES fire the
-- notify_customer_on_reservation_status() trigger on that UPDATE — so the
-- event this bug is about genuinely happens. But that trigger's 'completed'
-- branch was a raw `insert into notifications (...)` with no `channel`
-- column named, so `channel` silently took its `not null default 'in_app'`
-- (added by 20260808_notification_config.sql). The Database Webhook still
-- fires send-notification-email on that insert, but the function's very
-- first gate (`if (notification.channel !== 'email') return skipped`)
-- rejects it immediately — an in-app row is created (visible on
-- /notifications.html), but no email is ever attempted. Every OTHER
-- customer-facing status branch in this same trigger (approved,
-- cancellation_approved, cancelled) already goes through
-- dispatch_notification(), which inserts a SEPARATE channel='email' row
-- when the template has send_email=true — 'completed' was the one branch
-- 20260808_notification_config.sql's own header comment explicitly
-- deferred out of its initial 6-trigger catalogue ("Every other branch...
-- completed reservation-status case... is NOT in the catalogue"). This
-- migration adds it.

-- ═══════════════════════════════════════════════════════════════════════════
-- 1. New trigger + template — same catalogue shape as the existing 6
-- ═══════════════════════════════════════════════════════════════════════════

insert into public.notification_trigger (code, label, description, is_disableable, sort_order) values
  ('reservation_completed', 'Reservation completed', 'Sent when a reservation is marked complete after the event.', true, 7)
on conflict (code) do nothing;

insert into public.notification_template (trigger_code, email_subject, body) values
  ('reservation_completed', 'Thank you for celebrating with ELI Coffee Events!',
   'Hi {{customer_name}}, your {{event_type}} reservation for {{event_date}} is now complete. Thank you for choosing ELI Coffee Events — we hope you had a wonderful time, and we''d love to host you again!')
on conflict (trigger_code) do nothing;

-- ═══════════════════════════════════════════════════════════════════════════
-- 2. notify_customer_on_reservation_status() — 'completed' branch now goes
--    through dispatch_notification(), same as 'approved'/'cancelled'/
--    'cancellation_approved'. Every other branch is byte-identical to the
--    current live version (20260909_fix_customer_notification_link_target.sql).
-- ═══════════════════════════════════════════════════════════════════════════

create or replace function public.notify_customer_on_reservation_status()
returns trigger language plpgsql security definer as $$
declare
  v_merge_data jsonb;
begin
  if NEW.status is not distinct from OLD.status then return NEW; end if;

  case NEW.status
    when 'approved' then
      v_merge_data := public.build_notification_merge_data(NEW.reservation_id);
      perform public.dispatch_notification(NEW.user_id, 'reservation_confirmed', 'reservation_status', '/notifications.html', v_merge_data);
    when 'declined' then
      insert into notifications (user_id, type, title, body, link)
      values (NEW.user_id, 'reservation_status', 'Reservation Not Approved', 'Unfortunately, your reservation was not approved at this time.', '/notifications.html');
    when 'for_contract_signing' then
      insert into notifications (user_id, type, title, body, link)
      values (NEW.user_id, 'reservation_status', 'Contract Ready to Sign', 'Your reservation is confirmed. Please upload your signed contract to proceed.', '/notifications.html');
    when 'for_finalization' then
      insert into notifications (user_id, type, title, body, link)
      values (NEW.user_id, 'reservation_status', 'Contract Verified', 'Your signed contract has been verified. Your reservation is now moving to the finalization stage.', '/notifications.html');
    when 'completed' then
      v_merge_data := public.build_notification_merge_data(NEW.reservation_id);
      perform public.dispatch_notification(NEW.user_id, 'reservation_completed', 'reservation_status', '/notifications.html', v_merge_data);
    when 'cancellation_approved' then
      v_merge_data := public.build_notification_merge_data(NEW.reservation_id);
      perform public.dispatch_notification(NEW.user_id, 'cancellation_approved', 'reservation_status', '/notifications.html', v_merge_data);
    when 'cancelled' then
      v_merge_data := public.build_notification_merge_data(NEW.reservation_id);
      perform public.dispatch_notification(NEW.user_id, 'cancellation_confirmed', 'reservation_status', '/notifications.html', v_merge_data);
    else return NEW;
  end case;

  return NEW;
end;
$$;
