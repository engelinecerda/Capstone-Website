-- Payment ledger, Phase 1: in-café payment recording.
--
-- Extends the existing public.payment table (does NOT create a new
-- reservation_payments table) with the columns needed to record a payment a
-- manager takes at the counter, plus a single server-side view every UI
-- surface reads for computed payment status — replacing several
-- independently-drifted client-side sum functions (see js/admin_reservation_
-- details.js, js/admin_payments.js, js/admin_reservations.js), none of which
-- correctly excluded cancellation_fee/reschedule_fee from "total paid toward
-- the reservation."
--
-- Run manually in the Supabase SQL Editor per this project's convention.

-- ============================================================
-- 1. New columns on public.payment
-- ============================================================
alter table public.payment
  add column if not exists payment_source text not null default 'online' check (payment_source in ('online', 'in_cafe')),
  add column if not exists actual_payment_date date,
  add column if not exists actual_payment_time time,
  add column if not exists recorded_by uuid references public.profiles(user_id),
  add column if not exists reversal_of_payment_id uuid references public.payment(payment_id),
  add column if not exists is_reversal boolean not null default false;

-- ============================================================
-- 2. Backfill existing rows
-- ============================================================

-- Anything previously recorded as cash/card was always the onsite flow —
-- reclassify it as in_cafe. Everything else (gcash/maya/bpi/bank/ewallet,
-- and rows with no payment_method) keeps the column's 'online' default.
update public.payment
set payment_source = 'in_cafe'
where payment_method in ('cash', 'card');

-- actual_payment_date/time from the best existing source. payment_date is
-- populated by the online flow, cash_payment_date by the onsite flow;
-- submitted_at is the only field guaranteed to exist, so it's the final
-- fallback. The migration note only gets appended in that true-fallback
-- case, not whenever payment_date happens to be null but cash_payment_date
-- covers it (or vice versa).
update public.payment
set
  actual_payment_date = coalesce(payment_date, cash_payment_date, submitted_at::date),
  actual_payment_time = submitted_at::time,
  notes = case
    when payment_date is null and cash_payment_date is null
      then trim(both ' ' from coalesce(notes, '') || ' Migrated record — original payment date unavailable.')
    else notes
  end
where actual_payment_date is null;

-- ============================================================
-- 3. reservation_payment_summary — the one computed-status source
-- ============================================================
-- cancellation_fee/reschedule_fee are penalty/change fees, not payments
-- toward the reservation's own total, so they're excluded from total_paid.
-- They still appear in the payment history table (a separate query) —
-- this view is only for the balance/status figures.
create or replace view public.reservation_payment_summary as
select
  r.reservation_id,
  r.total_price as reservation_total,
  coalesce(p.total_paid, 0) as total_paid,
  greatest(r.total_price - coalesce(p.total_paid, 0), 0) as outstanding_balance,
  p.latest_payment_date,
  case
    when coalesce(p.total_paid, 0) = 0 then 'unpaid'
    when coalesce(p.total_paid, 0) < r.total_price then 'partially_paid'
    when coalesce(p.total_paid, 0) = r.total_price then 'paid_in_full'
    else 'overpaid'
  end as computed_status
from public.reservations r
left join lateral (
  select
    sum(pay.amount) as total_paid,
    max(coalesce(pay.actual_payment_date, pay.payment_date, pay.cash_payment_date, pay.submitted_at::date)) as latest_payment_date
  from public.payment pay
  where pay.reservation_id = r.reservation_id
    and lower(pay.payment_status) = 'approved'
    and pay.payment_type not in ('cancellation_fee', 'reschedule_fee')
) p on true;

-- Views run with the querying session's own permissions against the
-- underlying tables (reservations/payment), so existing RLS on those two
-- already restricts rows correctly here — customers see only their own
-- reservation's summary, manager/admin see all.
grant select on public.reservation_payment_summary to authenticated;

-- ============================================================
-- 4. Manager can insert in-café payments
-- ============================================================
-- Additive only — does not touch whatever untracked policy already lets
-- customers insert online payment rows (RLS policies OR together). Admin
-- gets nothing here; combined with there being no INSERT policy for admin
-- anywhere and no DELETE policy at all, admin has zero write access to this
-- table (default-deny), satisfying append-only + admin-read-only.
drop policy if exists "manager insert in-cafe payments" on public.payment;
create policy "manager insert in-cafe payments"
  on public.payment for insert
  with check (
    get_my_role() = 'manager'
    and payment_source = 'in_cafe'
    and payment_status = 'approved'
    and recorded_by = auth.uid()
  );

-- ============================================================
-- 5. validate_payment_submission() — skip customer-oriented checks for
--    manager-recorded in-café rows
-- ============================================================
-- The deposit-floor and remaining-balance-cap checks below exist to bound
-- customer self-service partial payments. A manager recording a real cash/
-- card payment must be able to record any amount actually received,
-- including less than the deposit floor and more than the outstanding
-- balance (overpayment is a supported, surfaced state — not an error).
create or replace function public.validate_payment_submission()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_total_price numeric;
  v_approved_total numeric;
  v_remaining numeric;
  v_deposit_pct numeric := 30;
  v_min_amount numeric;
  v_rules jsonb;
begin
  if new.payment_source = 'in_cafe' then
    return new;
  end if;

  if new.reference_number is not null and new.payment_method in ('gcash', 'maya', 'bpi') then
    if new.payment_method = 'gcash' and new.reference_number !~ '^[0-9]{13}$' then
      raise exception 'GCash reference number must be exactly 13 digits.';
    elsif new.payment_method = 'maya' and new.reference_number !~ '^[0-9]{12,13}$' then
      raise exception 'Maya reference number must be 12 to 13 digits.';
    elsif new.payment_method = 'bpi' and new.reference_number !~ '^[A-Za-z0-9]{10,13}$' then
      raise exception 'BPI reference number must be 10 to 13 letters or numbers.';
    end if;
  end if;

  if new.payment_type = 'partial_payment' then
    select r.total_price into v_total_price
    from public.reservations r
    where r.reservation_id = new.reservation_id;

    if v_total_price is null then
      raise exception 'Reservation not found for this payment.';
    end if;

    select coalesce(sum(p.amount), 0) into v_approved_total
    from public.payment p
    where p.reservation_id = new.reservation_id
      and p.reschedule_request_id is null
      and lower(p.payment_status) = 'approved';

    v_remaining := greatest(v_total_price - v_approved_total, 0);

    select setting_value::jsonb into v_rules
    from public.system_settings
    where setting_key = 'reservation_rules';

    if v_rules is not null and v_rules ? 'deposit_pct' then
      v_deposit_pct := (v_rules->>'deposit_pct')::numeric;
    end if;

    v_min_amount := round(least(v_total_price * v_deposit_pct / 100, v_remaining), 2);

    if new.amount is null or new.amount <= 0 then
      raise exception 'Custom payment amount must be greater than zero.';
    end if;
    if new.amount < v_min_amount then
      raise exception 'Custom payment amount must be at least %.', v_min_amount;
    end if;
    if new.amount > v_remaining then
      raise exception 'Custom payment amount cannot exceed the remaining balance of %.', v_remaining;
    end if;
  end if;

  return new;
end;
$$;

-- ============================================================
-- 6. Diagnostic — reservations whose paid-total changes under the new
--    fee-exclusion rule. Manual review only; nothing here is enforced.
--    This project never stored a payment-status column to diff against
--    (status was always computed client-side), so this is the practical
--    equivalent verification: it isolates exactly the one behavioral
--    change this migration makes to the money math.
-- ============================================================
select
  r.reservation_id,
  old_sum.old_total,
  new_view.total_paid as new_total,
  old_sum.old_total - new_view.total_paid as delta
from public.reservations r
join public.reservation_payment_summary new_view on new_view.reservation_id = r.reservation_id
join lateral (
  select coalesce(sum(p.amount), 0) as old_total
  from public.payment p
  where p.reservation_id = r.reservation_id
    and p.reschedule_request_id is null
    and lower(p.payment_status) = 'approved'
) old_sum on true
where old_sum.old_total <> new_view.total_paid;
