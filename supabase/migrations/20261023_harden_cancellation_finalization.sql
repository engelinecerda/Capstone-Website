-- Fix: an approved cancellation_fee payment could leave a reservation
-- permanently stuck showing its full original balance as still due, even
-- though the cancellation was paid for and processed.
--
-- Root cause: finalize_cancellation_on_fee_approval() (20260909_reschedule_
-- hold_and_cancellation_debt.sql) only finalizes a reservation whose status
-- is EXACTLY 'cancellation_requested' at the moment its fee is approved —
--   select * into v_reservation from public.reservations
--   where reservation_id = new.reservation_id and status = 'cancellation_requested';
--   if v_reservation.reservation_id is null then return new; end if;
-- If the status was anything else for any reason at that instant, this
-- silently no-ops: no error, no log. The payment is left sitting
-- "approved" forever, but the reservation itself never transitions to
-- 'cancelled' — so every downstream consumer that gates "is this
-- cancelled?" on reservations.status (isReservationPaymentEnabled in
-- reservation_shared.js, and everything built on it: getAvailablePaymentOptions,
-- getPaymentPageState, the account.js reservation card) keeps treating it as
-- an ordinary active booking and keeps presenting its full remaining
-- balance as payable — which is exactly the reported symptom, and exactly
-- why it blocks the customer from booking again (the system genuinely
-- believes they still owe the original package balance).
--
-- The business rule this trigger exists to enforce is unambiguous: an
-- approved cancellation_fee payment is unconditional proof the
-- reservation is cancelled, full stop — per this site's own cancellation
-- policy copy ("payment already made is strictly non-refundable... the
-- cancellation fee must be paid to complete the cancellation"). There is
-- no reservation status this could legitimately arrive from (pending,
-- approved, confirmed, rescheduled, cancellation_requested, or the
-- legacy cancellation_approved) where "finalize it anyway" is the wrong
-- call — only 'cancelled' (already done), 'completed', and 'declined'
-- are excluded, since those are unrelated terminal states a stray
-- cancellation_fee payment should never override.
-- ═══════════════════════════════════════════════════════════════════════════

create or replace function public.finalize_cancellation_on_fee_approval()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_reservation public.reservations%rowtype;
begin
  if new.payment_type is distinct from 'cancellation_fee'
     or lower(coalesce(new.payment_status, '')) is distinct from 'approved'
     or old.payment_status is not distinct from new.payment_status then
    return new;
  end if;

  -- Widened from "status = 'cancellation_requested'" (see header) to any
  -- non-terminal status: an approved cancellation_fee is unconditional
  -- proof of cancellation regardless of exactly which status the
  -- reservation happened to be sitting in the instant this fired.
  select * into v_reservation
  from public.reservations
  where reservation_id = new.reservation_id
    and lower(coalesce(status, '')) not in ('cancelled', 'completed', 'declined');

  if v_reservation.reservation_id is null then
    return new;
  end if;

  update public.reservations
  set status = 'cancelled',
      cancellation_hold_expires_at = null
  where reservation_id = v_reservation.reservation_id;

  insert into public.reservation_status (reservation_id, previous_status, new_status, changed_at)
  values (v_reservation.reservation_id, v_reservation.status, 'cancelled', now());

  insert into public.reservation_cancellations (reservation_id, user_id, previous_status, reason, cancelled_at)
  values (
    v_reservation.reservation_id,
    v_reservation.user_id,
    coalesce(v_reservation.pre_cancellation_status, v_reservation.status, 'approved'),
    coalesce(v_reservation.cancellation_reason, 'Cancelled by customer'),
    now()
  )
  on conflict (reservation_id) do nothing;

  return new;
end;
$$;

-- trg_finalize_cancellation_on_fee_approval (after update on public.payment,
-- 20260909_reschedule_hold_and_cancellation_debt.sql) already points at
-- this function by name — no trigger changes needed.

-- ============================================================
-- Backfill — correct every reservation already stuck in this broken state
-- right now: an approved cancellation_fee payment exists, but the
-- reservation was never actually finalized to 'cancelled'. Reuses the
-- exact same logic as the trigger above, one row at a time, so history
-- (reservation_status, reservation_cancellations) is backfilled
-- consistently rather than just patching the status column directly.
-- ============================================================
do $$
declare
  -- Named v_row, not r — a PL/pgSQL record variable sharing a name with a
  -- table alias used inside its own defining query (reservations r below)
  -- is ambiguous: Postgres reads r.reservation_id etc. as the not-yet-
  -- assigned record itself rather than the query's alias, raising
  -- "record r is not assigned yet". Confirmed by running this migration.
  v_row record;
begin
  for v_row in
    select distinct r.reservation_id, r.status, r.user_id, r.pre_cancellation_status, r.cancellation_reason
    from public.reservations r
    join public.payment p
      on p.reservation_id = r.reservation_id
     and p.payment_type = 'cancellation_fee'
     and lower(coalesce(p.payment_status, '')) = 'approved'
    where lower(coalesce(r.status, '')) not in ('cancelled', 'completed', 'declined')
  loop
    update public.reservations
    set status = 'cancelled',
        cancellation_hold_expires_at = null
    where reservation_id = v_row.reservation_id;

    insert into public.reservation_status (reservation_id, previous_status, new_status, changed_at)
    values (v_row.reservation_id, v_row.status, 'cancelled', now());

    insert into public.reservation_cancellations (reservation_id, user_id, previous_status, reason, cancelled_at)
    values (
      v_row.reservation_id,
      v_row.user_id,
      coalesce(v_row.pre_cancellation_status, v_row.status, 'approved'),
      coalesce(v_row.cancellation_reason, 'Cancelled by customer'),
      now()
    )
    on conflict (reservation_id) do nothing;

    raise notice 'Backfilled reservation % from status % to cancelled', v_row.reservation_id, v_row.status;
  end loop;
end;
$$;
