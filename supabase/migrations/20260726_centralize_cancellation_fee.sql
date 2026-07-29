-- Centralizes the cancellation fee amount, previously hardcoded identically
-- in three places: js/reservation_shared.js (getCancellationFee), the
-- inline duplicate in js/customer_payments.js, and this function. All three
-- now read from the same source: the payment_rules system_settings row
-- (cancellation_fee_onsite / cancellation_fee_offsite), with the same
-- 500/2000 numbers as the fallback default if an admin never saves the
-- panel — so behavior is unchanged unless the admin explicitly edits it in
-- Payment options → Payment Rules. Mirrors the exact pattern this function
-- already uses two lines below for auto_cancel_days.
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
begin
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
      ) as has_pending_payment
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

    v_due_date := v_res.event_date - 7;
    v_grace_deadline := v_due_date::timestamptz + (v_auto_cancel_days || ' days')::interval;
    if v_grace_deadline > now() then
      continue;
    end if;

    v_cancellation_fee := case when lower(v_res.location_type) = 'offsite' then v_cancel_fee_offsite else v_cancel_fee_onsite end;

    update public.reservations
    set status = 'cancelled', cancellation_reason = 'auto_cancelled_overdue'
    where reservation_id = v_res.reservation_id;

    insert into public.reservation_cancellations (reservation_id, user_id, previous_status, reason, cancelled_at)
    values (
      v_res.reservation_id, v_res.user_id, v_res.status,
      'Automatically cancelled: payment was not received within the grace period.',
      now()
    )
    on conflict (reservation_id) do update
      set previous_status = excluded.previous_status,
          reason = excluded.reason,
          cancelled_at = excluded.cancelled_at;

    insert into public.payment (reservation_id, payment_type, amount, payment_status, submitted_at)
    values (v_res.reservation_id, 'cancellation_fee', v_cancellation_fee, 'pending_review', now());

    insert into public.reservation_status (reservation_id, previous_status, new_status, changed_at)
    values (v_res.reservation_id, v_res.status, 'cancelled', now());
  end loop;
end;
$$;
