-- Fix: a reservation auto-cancelled with NOTHING paid no longer blocks new
-- bookings with a "₱0.00 unpaid cancellation fee".
--
-- What went wrong: 20261201 stopped auto_cancel_overdue_reservations() from
-- creating a cancellation_fee row when nothing was paid. But three server
-- checks still defined "cancellation debt" as "cancelled reservation with no
-- APPROVED cancellation_fee payment" - which is also true when there is no fee
-- row at all. So the customer was still blocked, now with a fee of 0.00
-- (the RPC falls back to 0 when no fee row exists). The customer-side JS
-- already knew about the fee-free case (isCancellationFeeWaived() in
-- js/reservation_shared.js); these database checks did not.
--
-- Fix: one shared rule, public.is_cancellation_fee_waived(), identical to the
-- JS helper (cancelled + cancellation_reason = 'auto_cancelled_overdue' + NO
-- cancellation_fee row), and the three checks now skip waived reservations:
--   1. block_booking_with_unresolved_cancellation_debt()  (insert trigger)
--   2. get_booking_block_reason()                         (booking-form pre-check)
--   3. flag_overdue_cancellation_balances()               (daily manager alert)
-- Because the rule only holds while no fee row exists, a fee that is added
-- later (by staff, or because something was paid) makes the debt count again.
--
-- Unchanged on purpose: auto_cancel_overdue_reservations(), the overdue-balance
-- block (part A of the RPC and its trigger), fee amounts, cron schedules.
-- Existing data is NOT touched. Reservations auto-cancelled before 20261201
-- already have a pending fee row, so they are still real debt until voided.

create or replace function public.is_cancellation_fee_waived(p_reservation_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.reservations r
    where r.reservation_id = p_reservation_id
      and lower(r.status) = 'cancelled'
      and r.cancellation_reason = 'auto_cancelled_overdue'
  )
  and not exists (
    select 1 from public.payment p
    where p.reservation_id = p_reservation_id
      and p.payment_type = 'cancellation_fee'
  );
$$;

grant execute on function public.is_cancellation_fee_waived(uuid) to authenticated, service_role;

-- 1. Insert trigger ---------------------------------------------------------
create or replace function public.block_booking_with_unresolved_cancellation_debt()
returns trigger
language plpgsql
as $$
declare
  v_owed numeric;
begin
  if tg_op <> 'INSERT' then
    return new;
  end if;

  select count(*) into v_owed
  from public.reservations r
  where r.user_id = new.user_id
    and r.status = 'cancelled'
    and not public.is_cancellation_fee_waived(r.reservation_id)  -- 20261202
    and not exists (
      select 1 from public.payment p
      where p.reservation_id = r.reservation_id
        and p.payment_type = 'cancellation_fee'
        and lower(coalesce(p.payment_status, '')) = 'approved'
    );

  if v_owed > 0 then
    raise exception using
      errcode = 'P0001',
      message = 'You have an outstanding balance from a previous cancellation — please settle it before booking again.';
  end if;

  return new;
end;
$$;

-- 2. Booking-form pre-check -------------------------------------------------
-- Reproduced from 20260914_block_booking_with_overdue_balance.sql; only the
-- line marked 20261202 is new.
create or replace function public.get_booking_block_reason()
returns jsonb
language plpgsql
as $$
declare
  v_user_id uuid := auth.uid();
  v_auto_cancel_days integer := 5;
  v_rules jsonb;
  v_bal record;
  v_fee record;
begin
  if v_user_id is null then
    return jsonb_build_object('blocked', false);
  end if;

  select setting_value::jsonb into v_rules
  from public.system_settings
  where setting_key = 'reservation_rules';

  if v_rules is not null and v_rules ? 'auto_cancel_days' then
    v_auto_cancel_days := (v_rules->>'auto_cancel_days')::integer;
  end if;

  -- A. Overdue balance on an active reservation
  select r.reservation_id, r.reservation_number, s.outstanding_balance,
         (r.event_date - public.get_full_payment_days()) as due_date
  into v_bal
  from public.reservations r
  join public.reservation_payment_summary s on s.reservation_id = r.reservation_id
  where r.user_id = v_user_id
    and lower(r.status) in ('approved', 'confirmed', 'rescheduled')
    and s.outstanding_balance > 0
    and now() > (
      (r.event_date - public.get_full_payment_days())::timestamptz
      + (v_auto_cancel_days || ' days')::interval
    )
  order by r.event_date asc
  limit 1;

  if found then
    return jsonb_build_object(
      'blocked', true,
      'reason', 'overdue_balance',
      'reservation_id', v_bal.reservation_id,
      'reservation_number', v_bal.reservation_number,
      'balance_due', v_bal.outstanding_balance,
      'due_date', v_bal.due_date
    );
  end if;

  -- B. Unpaid cancellation debt
  select r.reservation_id, r.reservation_number,
         coalesce((
           select p.amount from public.payment p
           where p.reservation_id = r.reservation_id
             and p.payment_type = 'cancellation_fee'
           order by p.submitted_at desc
           limit 1
         ), 0) as fee_amount
  into v_fee
  from public.reservations r
  where r.user_id = v_user_id
    and r.status = 'cancelled'
    and not public.is_cancellation_fee_waived(r.reservation_id)  -- 20261202
    and not exists (
      select 1 from public.payment p
      where p.reservation_id = r.reservation_id
        and p.payment_type = 'cancellation_fee'
        and lower(coalesce(p.payment_status, '')) = 'approved'
    )
  limit 1;

  if found then
    return jsonb_build_object(
      'blocked', true,
      'reason', 'unpaid_cancellation_fee',
      'reservation_id', v_fee.reservation_id,
      'reservation_number', v_fee.reservation_number,
      'balance_due', v_fee.fee_amount
    );
  end if;

  return jsonb_build_object('blocked', false);
end;
$$;

grant execute on function public.get_booking_block_reason() to authenticated;

-- 3. Daily overdue-cancellation-balance alert ---------------------------------
-- Reproduced from 20260909_reschedule_hold_and_cancellation_debt.sql; only the
-- condition marked 20261202 is new. Its cron job is unchanged.
create or replace function public.flag_overdue_cancellation_balances()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_rules_json  jsonb;
  v_grace_days  integer := 7;
  bal record;
begin
  select ss.setting_value::jsonb into v_rules_json
  from public.system_settings ss
  where ss.setting_key = 'payment_rules';
  v_grace_days := coalesce((v_rules_json->>'cancellation_balance_grace_days')::integer, 7);

  for bal in
    select
      r.reservation_id,
      r.contact_name,
      coalesce(
        p.amount,
        case when lower(coalesce(r.location_type, '')) = 'offsite' then
          coalesce((v_rules_json->>'cancellation_fee_offsite')::numeric, 2000)
        else
          coalesce((v_rules_json->>'cancellation_fee_onsite')::numeric, 500)
        end
      ) as amount,
      coalesce(p.submitted_at, rc.cancelled_at) as anchor_at
    from public.reservations r
    join public.reservation_cancellations rc on rc.reservation_id = r.reservation_id
    left join lateral (
      select amount, submitted_at
      from public.payment
      where reservation_id = r.reservation_id
        and payment_type = 'cancellation_fee'
        and lower(coalesce(payment_status, '')) in ('pending_review', 'rejected')
      order by submitted_at desc
      limit 1
    ) p on true
    where r.status = 'cancelled'
      -- 20261202: a fee-free auto-cancel (nothing paid) owes nothing to flag.
      and not public.is_cancellation_fee_waived(r.reservation_id)
      and not exists (
        select 1 from public.payment ap
        where ap.reservation_id = r.reservation_id
          and ap.payment_type = 'cancellation_fee'
          and lower(coalesce(ap.payment_status, '')) = 'approved'
      )
      and coalesce(p.submitted_at, rc.cancelled_at) < now() - make_interval(days => v_grace_days)
      and not exists (
        select 1 from public.reminder_sent rs
        where rs.reservation_id = r.reservation_id
          and rs.reminder_type = 'cancellation_balance_overdue'
          and rs.target_date = coalesce(p.submitted_at, rc.cancelled_at)::date
      )
  loop
    insert into public.reminder_sent (reservation_id, reminder_type, target_date)
    values (bal.reservation_id, 'cancellation_balance_overdue', bal.anchor_at::date);

    insert into public.notifications (user_id, type, title, body, link)
    select user_id, 'payment_overdue',
           'Overdue Cancellation Balance',
           coalesce(bal.contact_name, 'A customer') || ' has an unpaid cancellation fee of ' || bal.amount::text || ' past the grace period.',
           '/admin/payments.html?reservation=' || bal.reservation_id
    from public.profiles
    where role = 'manager';
  end loop;
end;
$$;

grant execute on function public.flag_overdue_cancellation_balances() to service_role;
