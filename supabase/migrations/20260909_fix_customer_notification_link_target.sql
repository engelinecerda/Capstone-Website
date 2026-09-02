-- Fix: clicking a customer notification (navbar bell dropdown or the full
-- /notifications.html page) sent the customer to /account.html instead of
-- staying on the notification history page. Root cause: every customer-
-- facing notification insert across the trigger functions below hardcodes
-- link = '/account.html' — that was never correct for a "go to this
-- notification" click, it's just the page these notifications happen to be
-- *about*. The fix is link = '/notifications.html' everywhere a customer
-- notification is created; admin-facing rows (which link into
-- /admin/reservations.html) are untouched.
--
-- This migration re-creates the current live version of each affected
-- function (byte-identical apart from the link value) so the fix takes
-- effect for all future notifications, and separately backfills existing
-- rows so notifications already in a customer's inbox link correctly too.

-- ═══════════════════════════════════════════════════════════════════════════
-- 1. BACKFILL EXISTING ROWS
-- ═══════════════════════════════════════════════════════════════════════════

update public.notifications
set link = '/notifications.html'
where link = '/account.html';

-- ═══════════════════════════════════════════════════════════════════════════
-- 2. notify_customer_on_reservation_status()
--    (current live version from 20260812_cancellation_workflow.sql)
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
      insert into notifications (user_id, type, title, body, link)
      values (NEW.user_id, 'reservation_status', 'Reservation Complete', 'Your event reservation is now marked complete. Thank you for choosing ELI Coffee Events!', '/notifications.html');
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
-- 3. notify_admins_on_reservation()
--    (current live version from 20260820_admin_notification_scoping.sql)
--    Only its customer-facing dispatch_notification() call (reservation_
--    submitted) changes — the two admin/manager inserts that link to
--    /admin/reservations.html are untouched.
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
    perform public.dispatch_notification(NEW.user_id, 'reservation_submitted', 'reservation_status', '/notifications.html', v_merge_data);

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
-- 4. notify_customer_on_payment_status()
--    (current live version from 20260808_notification_config.sql)
-- ═══════════════════════════════════════════════════════════════════════════

create or replace function public.notify_customer_on_payment_status()
returns trigger language plpgsql security definer as $$
declare
  v_user_id uuid;
  v_merge_data jsonb;
begin
  if NEW.payment_status is not distinct from OLD.payment_status then return NEW; end if;

  select r.user_id into v_user_id from reservations r where r.reservation_id = NEW.reservation_id;
  if v_user_id is null then return NEW; end if;

  case NEW.payment_status
    when 'approved' then
      v_merge_data := public.build_notification_merge_data(NEW.reservation_id);
      perform public.dispatch_notification(v_user_id, 'payment_received', 'payment_status', '/notifications.html', v_merge_data);
    when 'rejected' then
      v_merge_data := public.build_notification_merge_data(NEW.reservation_id)
        || jsonb_build_object('rejection_reason', coalesce(NEW.rejection_reason, 'Not specified'));
      perform public.dispatch_notification(v_user_id, 'payment_rejected', 'payment_status', '/notifications.html', v_merge_data);
    else return NEW;
  end case;

  return NEW;
end;
$$;

-- ═══════════════════════════════════════════════════════════════════════════
-- 5. notify_customer_on_reschedule_review()
--    (current live version from 20260808_notification_config.sql)
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
        values (v_user_id, 'reschedule_review', 'Reschedule Request Declined', 'Your reschedule request was declined. Please contact us if you have any questions.', '/notifications.html');
      end if;
    else return NEW;
  end case;

  return NEW;
end;
$$;

-- ═══════════════════════════════════════════════════════════════════════════
-- 6. send_due_reminders()
--    (current live version from 20260815_reminder_notifications.sql)
--    Only the link argument of each dispatch_notification() call changes.
-- ═══════════════════════════════════════════════════════════════════════════

create or replace function public.send_due_reminders()
returns void
language plpgsql
security definer
as $$
declare
  v_template   public.notification_template%rowtype;
  v_row        record;
  v_target_date date;
  v_ledger_id  uuid;
  v_merge_data jsonb;
  v_channel    text;
begin
  -- Payment due — nothing paid yet, settlement deadline approaching.
  select * into v_template from public.notification_template where trigger_code = 'payment_due';
  if found and v_template.is_enabled then
    for v_row in
      select r.reservation_id, r.user_id
      from public.reservations r
      join public.reservation_payment_summary s on s.reservation_id = r.reservation_id
      where public.is_capacity_blocking_reservation_status(r.status)
        and s.computed_status = 'unpaid'
        and r.event_date is not null
        and public.get_reservation_balance_due_date(r.reservation_id) - coalesce(v_template.lead_days, 3) = current_date
    loop
      v_target_date := public.get_reservation_balance_due_date(v_row.reservation_id);
      v_channel := case
        when v_template.send_in_app and v_template.send_email then 'in_app,email'
        when v_template.send_email then 'email'
        when v_template.send_in_app then 'in_app'
        else null
      end;

      insert into public.reminder_sent (reservation_id, reminder_type, target_date, channel)
      values (v_row.reservation_id, 'payment_due', v_target_date, v_channel)
      on conflict (reservation_id, reminder_type, target_date) do nothing
      returning id into v_ledger_id;

      if v_ledger_id is not null then
        v_merge_data := public.build_notification_merge_data(v_row.reservation_id);
        perform public.dispatch_notification(v_row.user_id, 'payment_due', 'payment_due', '/notifications.html', v_merge_data);
      end if;
    end loop;
  end if;

  -- Balance due — partial payment made, balance remains, same deadline.
  select * into v_template from public.notification_template where trigger_code = 'balance_due';
  if found and v_template.is_enabled then
    for v_row in
      select r.reservation_id, r.user_id
      from public.reservations r
      join public.reservation_payment_summary s on s.reservation_id = r.reservation_id
      where public.is_capacity_blocking_reservation_status(r.status)
        and s.computed_status = 'partially_paid'
        and r.event_date is not null
        and public.get_reservation_balance_due_date(r.reservation_id) - coalesce(v_template.lead_days, 3) = current_date
    loop
      v_target_date := public.get_reservation_balance_due_date(v_row.reservation_id);
      v_channel := case
        when v_template.send_in_app and v_template.send_email then 'in_app,email'
        when v_template.send_email then 'email'
        when v_template.send_in_app then 'in_app'
        else null
      end;

      insert into public.reminder_sent (reservation_id, reminder_type, target_date, channel)
      values (v_row.reservation_id, 'balance_due', v_target_date, v_channel)
      on conflict (reservation_id, reminder_type, target_date) do nothing
      returning id into v_ledger_id;

      if v_ledger_id is not null then
        v_merge_data := public.build_notification_merge_data(v_row.reservation_id);
        perform public.dispatch_notification(v_row.user_id, 'balance_due', 'balance_due', '/notifications.html', v_merge_data);
      end if;
    end loop;
  end if;

  -- Event reminder — reservation still active, event date approaching.
  select * into v_template from public.notification_template where trigger_code = 'event_reminder';
  if found and v_template.is_enabled then
    for v_row in
      select r.reservation_id, r.user_id, r.event_date
      from public.reservations r
      where public.is_capacity_blocking_reservation_status(r.status)
        and r.event_date is not null
        and r.event_date - coalesce(v_template.lead_days, 1) = current_date
    loop
      v_channel := case
        when v_template.send_in_app and v_template.send_email then 'in_app,email'
        when v_template.send_email then 'email'
        when v_template.send_in_app then 'in_app'
        else null
      end;

      insert into public.reminder_sent (reservation_id, reminder_type, target_date, channel)
      values (v_row.reservation_id, 'event_reminder', v_row.event_date, v_channel)
      on conflict (reservation_id, reminder_type, target_date) do nothing
      returning id into v_ledger_id;

      if v_ledger_id is not null then
        v_merge_data := public.build_notification_merge_data(v_row.reservation_id);
        perform public.dispatch_notification(v_row.user_id, 'event_reminder', 'event_reminder', '/notifications.html', v_merge_data);
      end if;
    end loop;
  end if;
end;
$$;
