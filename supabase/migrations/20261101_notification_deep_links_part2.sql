-- Notification deep links, part 2: the two hold-expiry notifications.
--
-- 20261027_notification_deep_links.sql made the templated customer
-- notifications (approved, payment received/rejected, cancellation, completed,
-- reminders, ...) link to the reservation they are about. Two customer
-- notifications are inserted directly by cron functions and were missed; they
-- still carried link = '/account.html', so clicking them only opened the
-- account page:
--
--   * "Reschedule Hold Expired"  (expire_reschedule_holds)
--   * "Cancellation Finalized"   (expire_cancellation_holds)
--
-- Both loops already select the reservation_id, so the link is now
-- '/reservation-details?reservation_id=<uuid>' (same shape as 20261027 and
-- js/account.js). Nothing else in either function changes; bodies are copied
-- from their only definition in 20260909_reschedule_hold_and_cancellation_debt.sql.
-- The cron schedules for both jobs are untouched.
--
-- Existing notifications are not touched here; see
-- 20261101b_backfill_legacy_notification_links.sql.

-- ═══════════════════════════════════════════════════════════════════════════
-- 1. expire_reschedule_holds()
-- ═══════════════════════════════════════════════════════════════════════════
create or replace function public.expire_reschedule_holds()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  req record;
begin
  for req in
    select rr.reschedule_request_id, rr.reservation_id, rr.requested_date, r.user_id
    from public.reschedule_requests rr
    join public.reservations r on r.reservation_id = rr.reservation_id
    where rr.status = 'approved_pending_payment'
      and rr.hold_expires_at is not null
      and rr.hold_expires_at < now()
  loop
    update public.reschedule_requests
    set status = 'expired', reviewed_at = now()
    where reschedule_request_id = req.reschedule_request_id;

    if req.user_id is not null then
      insert into public.notifications (user_id, type, title, body, link)
      values (
        req.user_id,
        'reservation_status',
        'Reschedule Hold Expired',
        'Your hold on ' || to_char(req.requested_date::timestamp, 'FMMonth DD, YYYY') || ' expired before the fee was paid. Your original date is unaffected — you can request a new reschedule any time.',
        '/reservation-details?reservation_id=' || req.reservation_id
      );
    end if;
  end loop;
end;
$$;

-- ═══════════════════════════════════════════════════════════════════════════
-- 2. expire_cancellation_holds()
-- ═══════════════════════════════════════════════════════════════════════════
create or replace function public.expire_cancellation_holds()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  req record;
begin
  for req in
    select reservation_id, user_id, event_date, cancellation_reason, pre_cancellation_status
    from public.reservations
    where status = 'cancellation_requested'
      and cancellation_hold_expires_at is not null
      and cancellation_hold_expires_at < now()
  loop
    update public.reservations
    set status = 'cancelled',
        cancellation_hold_expires_at = null
    where reservation_id = req.reservation_id;

    insert into public.reservation_status (reservation_id, previous_status, new_status, changed_at)
    values (req.reservation_id, 'cancellation_requested', 'cancelled', now());

    insert into public.reservation_cancellations (reservation_id, user_id, previous_status, reason, cancelled_at)
    values (
      req.reservation_id,
      req.user_id,
      coalesce(req.pre_cancellation_status, 'approved'),
      coalesce(req.cancellation_reason, 'Cancelled by customer'),
      now()
    )
    on conflict (reservation_id) do nothing;

    if req.user_id is not null then
      insert into public.notifications (user_id, type, title, body, link)
      values (
        req.user_id,
        'reservation_status',
        'Cancellation Finalized',
        'The payment deadline for your cancellation fee passed before it was verified, so your reservation for ' || to_char(req.event_date::timestamp, 'FMMonth DD, YYYY') || ' has been finalized as cancelled and the date released. The fee is still owed before you can book again.',
        '/reservation-details?reservation_id=' || req.reservation_id
      );
    end if;
  end loop;
end;
$$;
