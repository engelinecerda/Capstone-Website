-- Fix: approving an extension_fee payment sent the customer TWO
-- notifications back to back — the correct "Extension Approved" one from
-- finalize_extension_on_fee_approval() (20260920_package_extension_hours.sql),
-- and a second, misleading "Payment received... Remaining balance: X" one
-- from notify_customer_on_payment_status() (still live from 20260909_fix_
-- customer_notification_link_target.sql). The second notification's
-- {{amount_paid}} is built from reservation_payment_summary.total_paid —
-- the reservation's cumulative total across ALL payments — not the
-- extension fee just paid, so it showed the full reservation total (e.g.
-- ₱3,298.90) framed as "your payment", which is wrong and confusing for an
-- extension-fee payment.
--
-- Root cause: notify_customer_on_payment_status() fires unconditionally for
-- every payment_status change to approved/rejected, with no awareness that
-- extension_fee already has its own complete, correctly-worded notification
-- pair (approved + rejected) via finalize_extension_on_fee_approval().
--
-- Not applying the same exclusion to cancellation_fee or reschedule_fee:
-- checked their finalize triggers (finalize_cancellation_on_fee_approval in
-- 20260909_reschedule_hold_and_cancellation_debt.sql; no equivalent exists
-- for reschedule_fee at all) and neither sends its own notification, so
-- both still depend entirely on this generic function for the customer to
-- hear anything about their fee payment being approved/rejected. Excluding
-- them here would silently remove their only notification.
--
-- Fix: skip this function entirely for payment_type = 'extension_fee',
-- leaving finalize_extension_on_fee_approval() as the sole source of
-- notifications for that payment type.

create or replace function public.notify_customer_on_payment_status()
returns trigger language plpgsql security definer as $$
declare
  v_user_id uuid;
  v_merge_data jsonb;
begin
  if NEW.payment_status is not distinct from OLD.payment_status then return NEW; end if;
  if NEW.payment_type = 'extension_fee' then return NEW; end if;

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
