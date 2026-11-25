-- Auto-cancel: no cancellation fee when the reservation has no payment at all.
--
-- Before: auto_cancel_overdue_reservations() cancelled every approved
-- reservation that was past its payment due date AND grace period, and always
-- created a pending cancellation_fee for it — even when the customer had never
-- paid a single peso. That left the customer with a debt (and the "unpaid
-- cancellation fee" block on new bookings) for a booking they never paid for.
--
-- Now: if the reservation has no approved payment of any type, it is cancelled
-- normally (status, cancellation record, status history) and NO cancellation_fee
-- row is created. If anything was paid, behavior is unchanged: it is cancelled
-- and the cancellation fee is created as before.
--
-- Unchanged on purpose: the due-date + grace-period test, the skip for
-- reservations with a payment awaiting review, the skip for fully paid
-- reservations, the fee amounts, the system-job marker (20261104), the cron
-- schedule. The function below is reproduced from 20261104_auto_cancel_fee_
-- insert_bypass.sql with only the changes marked "20261201".
--
-- Existing data is NOT touched. Reservations that were already auto-cancelled
-- with a pending fee keep it until someone voids it deliberately.

create or replace function public.auto_cancel_overdue_reservations()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_auto_cancel_days integer := 5;
  v_rules jsonb;
  v_payment_rules jsonb;
  v_cancel_fee_onsite numeric := 500;
  v_cancel_fee_offsite numeric := 2000;
  v_res record;
  v_cancellation_fee numeric;
  v_due_date date;
  v_grace_deadline timestamptz;
  v_cancel_reason text;
begin
  -- Marks this transaction as the auto-cancel job so
  -- validate_payment_submission() (20261104) lets its system-generated
  -- cancellation_fee insert through. Transaction-local (is_local = true):
  -- it resets on its own at commit/rollback and never leaks to other sessions.
  perform set_config('app.system_job', 'auto_cancel_overdue_reservations', true);

  select setting_value::jsonb into v_rules
  from public.system_settings
  where setting_key = 'reservation_rules';

  if v_rules is not null and v_rules ? 'auto_cancel_days' then
    v_auto_cancel_days := (v_rules->>'auto_cancel_days')::integer;
  end if;

  select setting_value::jsonb into v_payment_rules
  from public.system_settings
  where setting_key = 'payment_rules';

  if v_payment_rules is not null and v_payment_rules ? 'cancellation_fee_onsite' then
    v_cancel_fee_onsite := (v_payment_rules->>'cancellation_fee_onsite')::numeric;
  end if;
  if v_payment_rules is not null and v_payment_rules ? 'cancellation_fee_offsite' then
    v_cancel_fee_offsite := (v_payment_rules->>'cancellation_fee_offsite')::numeric;
  end if;

  for v_res in
    select
      r.reservation_id, r.user_id, r.status, r.location_type, r.event_date, r.total_price,
      coalesce(sum(p.amount) filter (
        where lower(p.payment_status) = 'approved' and p.reschedule_request_id is null
      ), 0) as approved_total,
      bool_or(
        lower(p.payment_status) = 'pending_review' and p.reschedule_request_id is null
      ) as has_pending_payment,
      -- 20261201: any approved payment of ANY type (reschedule fees included).
      -- Zero means the customer has genuinely paid nothing on this reservation.
      coalesce(sum(p.amount) filter (
        where lower(p.payment_status) = 'approved'
      ), 0) as any_approved_total
    from public.reservations r
    left join public.payment p on p.reservation_id = r.reservation_id
    where lower(r.status) in ('approved', 'confirmed', 'rescheduled')
    group by r.reservation_id, r.user_id, r.status, r.location_type, r.event_date, r.total_price
  loop
    if v_res.approved_total >= v_res.total_price then
      continue;
    end if;
    if v_res.has_pending_payment then
      continue;
    end if;

    v_due_date := v_res.event_date - public.get_full_payment_days();
    v_grace_deadline := v_due_date::timestamptz + (v_auto_cancel_days || ' days')::interval;
    if v_grace_deadline > now() then
      continue;
    end if;

    v_cancellation_fee := case when lower(v_res.location_type) = 'offsite' then v_cancel_fee_offsite else v_cancel_fee_onsite end;

    -- 20261201: nothing paid at all -> cancel normally, no cancellation fee.
    -- The fee is for a customer who paid something and then walked away; a
    -- reservation that never received any payment has nothing to charge it
    -- against, and the debt would block the customer from booking again.
    v_cancel_reason := case
      when v_res.any_approved_total <= 0
        then 'Automatically cancelled: payment was not received within the grace period. No cancellation fee applies.'
      else 'Automatically cancelled: payment was not received within the grace period.'
    end;

    update public.reservations
    set status = 'cancelled', cancellation_reason = 'auto_cancelled_overdue'
    where reservation_id = v_res.reservation_id;

    insert into public.reservation_cancellations (reservation_id, user_id, previous_status, reason, cancelled_at)
    values (
      v_res.reservation_id, v_res.user_id, v_res.status,
      v_cancel_reason,
      now()
    )
    on conflict (reservation_id) do update
      set previous_status = excluded.previous_status,
          reason = excluded.reason,
          cancelled_at = excluded.cancelled_at;

    -- 20261201: only charge the fee when something was actually paid.
    if v_res.any_approved_total > 0 then
      insert into public.payment (reservation_id, payment_type, amount, payment_status, submitted_at)
      values (v_res.reservation_id, 'cancellation_fee', v_cancellation_fee, 'pending_review', now());
    end if;

    insert into public.reservation_status (reservation_id, previous_status, new_status, changed_at)
    values (v_res.reservation_id, v_res.status, 'cancelled', now());
  end loop;

  perform set_config('app.system_job', '', true);
end;
$$;

grant execute on function public.auto_cancel_overdue_reservations() to service_role;
