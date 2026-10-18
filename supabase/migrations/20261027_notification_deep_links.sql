-- Customer notifications now deep-link to the reservation they are about.
--
-- Before: every customer notification carried link = '/notifications.html'
-- (20260909_fix_customer_notification_link_target.sql), so clicking one in
-- the navbar dropdown only opened the notifications page, and clicking one
-- on that page just reloaded it — it looked clickable but led nowhere.
--
-- After: the link is '/reservation-details?reservation_id=<uuid>' (the same
-- URL js/account.js builds for its "View details" button, and the same shape
-- 20261020_additional_head_requests.sql already uses). send-notification-email
-- builds its CTA button from notifications.link, so emails benefit as well.
--
-- Scope: only the customer-facing link value changes. Admin/manager rows
-- (/admin/...) are untouched.

-- ═══════════════════════════════════════════════════════════════════════════
-- 1. dispatch_notification()
--    (current live version from 20260808_notification_config.sql)
--    Every templated customer notification (submitted, approved, payment
--    received/rejected, cancellation, reschedule confirmed, completed, and
--    the payment/balance/event reminders) already passes the reservation's
--    merge data, which includes reservation_number (unique). When a caller
--    passes the generic '/notifications.html' link, resolve it to that
--    reservation's details page here, once, instead of rewriting each trigger.
--    The user_id match keeps the link scoped to the recipient's own
--    reservation. If nothing resolves, the original link is kept.
-- ═══════════════════════════════════════════════════════════════════════════
create or replace function public.dispatch_notification(
  p_user_id uuid,
  p_trigger_code text,
  p_legacy_type text,
  p_link text,
  p_merge_data jsonb
)
returns void
language plpgsql
as $$
declare
  v_template public.notification_template%rowtype;
  v_trigger_label text;
  v_rendered record;
  v_link text := p_link;
  v_reservation_id uuid;
begin
  if p_user_id is null then return; end if;

  select * into v_template from public.notification_template where trigger_code = p_trigger_code;
  if not found or not v_template.is_enabled then
    return;
  end if;

  if p_link = '/notifications.html'
     and coalesce(p_merge_data->>'reservation_number', '') <> '' then
    select r.reservation_id into v_reservation_id
    from public.reservations r
    where r.reservation_number = p_merge_data->>'reservation_number'
      and r.user_id = p_user_id;
    if v_reservation_id is not null then
      v_link := '/reservation-details?reservation_id=' || v_reservation_id;
    end if;
  end if;

  select label into v_trigger_label from public.notification_trigger where code = p_trigger_code;
  select * into v_rendered from public.render_notification_template(p_trigger_code, p_merge_data);

  if v_template.send_in_app then
    insert into public.notifications (user_id, type, title, body, link, trigger_code, channel, status)
    values (p_user_id, p_legacy_type, coalesce(v_trigger_label, 'Notification'), v_rendered.body, v_link, p_trigger_code, 'in_app', 'sent');
  end if;

  if v_template.send_email then
    insert into public.notifications (user_id, type, title, body, link, trigger_code, channel, status)
    values (p_user_id, p_legacy_type, coalesce(v_rendered.subject, v_trigger_label, 'Notification'), v_rendered.body, v_link, p_trigger_code, 'email', 'pending');
  end if;
end;
$$;

-- ═══════════════════════════════════════════════════════════════════════════
-- 2. notify_customer_on_reservation_status()
--    (current live version from 20261007_completed_reservation_email.sql)
--    The templated branches are resolved by dispatch_notification() above.
--    The three hardcoded branches (declined, for_contract_signing,
--    for_finalization) insert directly, so they get the deep link here.
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
      values (NEW.user_id, 'reservation_status', 'Reservation Not Approved', 'Unfortunately, your reservation was not approved at this time.', '/reservation-details?reservation_id=' || NEW.reservation_id);
    when 'for_contract_signing' then
      insert into notifications (user_id, type, title, body, link)
      values (NEW.user_id, 'reservation_status', 'Contract Ready to Sign', 'Your reservation is confirmed. Please upload your signed contract to proceed.', '/reservation-details?reservation_id=' || NEW.reservation_id);
    when 'for_finalization' then
      insert into notifications (user_id, type, title, body, link)
      values (NEW.user_id, 'reservation_status', 'Contract Verified', 'Your signed contract has been verified. Your reservation is now moving to the finalization stage.', '/reservation-details?reservation_id=' || NEW.reservation_id);
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

-- ═══════════════════════════════════════════════════════════════════════════
-- 3. notify_customer_on_reschedule_review()
--    (current live version from 20260909_fix_customer_notification_link_
--    target.sql). Only the hardcoded 'rejected' branch changes; the
--    'approved_pending_payment' branch is resolved by dispatch_notification().
-- ═══════════════════════════════════════════════════════════════════════════
create or replace function public.notify_customer_on_reschedule_review()
returns trigger language plpgsql security definer as $$
declare
  v_user_id uuid;
  v_merge_data jsonb;
begin
  if NEW.status is not distinct from OLD.status then return NEW; end if;

  select r.user_id into v_user_id from reservations r where r.reservation_id = NEW.reservation_id;

  case NEW.status
    when 'approved_pending_payment' then
      if v_user_id is not null then
        v_merge_data := public.build_notification_merge_data(NEW.reservation_id);
        perform public.dispatch_notification(v_user_id, 'reschedule_confirmed', 'reschedule_review', '/notifications.html', v_merge_data);
      end if;
    when 'rejected' then
      if v_user_id is not null then
        insert into notifications (user_id, type, title, body, link)
        values (v_user_id, 'reschedule_review', 'Reschedule Request Declined', 'Your reschedule request was declined. Please contact us if you have any questions.', '/reservation-details?reservation_id=' || NEW.reservation_id);
      end if;
    else return NEW;
  end case;

  return NEW;
end;
$$;
