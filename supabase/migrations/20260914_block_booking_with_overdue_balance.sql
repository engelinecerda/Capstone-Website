-- New-booking gate, part 2 of 2.
--
-- 20260909_reschedule_hold_and_cancellation_debt.sql already added
-- block_booking_with_unresolved_cancellation_debt() — a BEFORE INSERT
-- trigger on public.reservations that blocks a new booking if the customer
-- has a `status = 'cancelled'` reservation with no APPROVED cancellation_fee
-- payment. That covers cancellation debt. It does NOT cover the original
-- scenario this was built for: a customer with an ACTIVE reservation
-- (approved/confirmed/rescheduled, never cancelled) whose balance is
-- overdue. This migration adds that second, narrower check as its own
-- trigger — same file-per-concern style as the existing one, not merged
-- into enforce_reservation_capacity() (a different function, a different
-- concern: package/guest/scheduling validity, not cross-reservation debt).
--
-- Deliberately gates on GRACE-EXPIRED overdue balance, not "any nonzero
-- balance" — this system is built around partial payment (deposit now,
-- balance due closer to the event), so most active reservations legitimately
-- carry a nonzero balance for most of their life. Blocking on that alone
-- would punish every repeat customer using the payment plan as designed,
-- not just the ones actually at risk of non-payment. The threshold used
-- here — event_date - full_payment_days, plus auto_cancel_days grace — is
-- the exact same math auto_cancel_overdue_reservations()
-- (20260818_flagged_fixes.sql) uses to decide when to auto-cancel for
-- non-payment. In practice the hourly cron already converts most of these
-- into 'cancelled' + unpaid cancellation debt (caught by the existing
-- trigger) before a customer could act — this trigger's real job is closing
-- the up-to-an-hour race window before that cron runs, and not depending
-- entirely on cron health for enforcement.
--
-- Reuses existing shared building blocks rather than re-deriving them:
--   - public.get_full_payment_days() (20260818_flagged_fixes.sql)
--   - public.reservation_payment_summary (20260725_payment_ledger.sql) —
--     already excludes cancellation_fee/reschedule_fee from total_paid, so
--     outstanding_balance here means the same thing it means everywhere
--     else this view is read.
-- No SECURITY DEFINER / search_path override, matching
-- block_booking_with_unresolved_cancellation_debt()'s style exactly: this
-- only ever reads the inserting customer's own rows (new.user_id, which
-- RLS already requires to equal auth.uid() for a customer INSERT), so it
-- runs fine as the invoking customer under existing RLS.

create or replace function public.block_booking_with_overdue_balance()
returns trigger
language plpgsql
as $$
declare
  v_owed integer;
  v_auto_cancel_days integer := 5;
  v_rules jsonb;
begin
  if tg_op <> 'INSERT' then
    return new;
  end if;

  select setting_value::jsonb into v_rules
  from public.system_settings
  where setting_key = 'reservation_rules';

  if v_rules is not null and v_rules ? 'auto_cancel_days' then
    v_auto_cancel_days := (v_rules->>'auto_cancel_days')::integer;
  end if;

  select count(*) into v_owed
  from public.reservations r
  join public.reservation_payment_summary s on s.reservation_id = r.reservation_id
  where r.user_id = new.user_id
    and lower(r.status) in ('approved', 'confirmed', 'rescheduled')
    and s.outstanding_balance > 0
    and now() > (
      (r.event_date - public.get_full_payment_days())::timestamptz
      + (v_auto_cancel_days || ' days')::interval
    );

  if v_owed > 0 then
    raise exception using
      errcode = 'P0001',
      message = 'You have an overdue balance on a previous reservation — please settle it before booking another event.';
  end if;

  return new;
end;
$$;

drop trigger if exists trg_block_booking_with_overdue_balance on public.reservations;
create trigger trg_block_booking_with_overdue_balance
before insert on public.reservations
for each row execute function public.block_booking_with_overdue_balance();

-- ============================================================
-- Client-side pre-check RPC — lets reservations.html tell a blocked
-- customer WHY before they fill out the whole form, instead of them only
-- finding out from a rejected INSERT at the very end. Mirrors both trigger
-- conditions above (this one + the existing cancellation-debt one) exactly,
-- so the pre-check and the actual server-side enforcement never disagree.
-- No parameter — always checks auth.uid(), so a customer can only ever
-- probe their own status, never anyone else's, regardless of how it's called.
-- ============================================================
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
