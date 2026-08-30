-- Fix: Bank Transfer payment method rejects valid non-BPI reference numbers.
--
-- Root cause: the payment_method row's label was never actually renamed —
-- it's still literally 'BPI' in the table (backfilled from the old
-- mode_of_payment free-text column in 20260729_payment_method_evidence_
-- and_snapshot.sql). js/customer_payments.js's resolveLegacyModeKey()
-- matches that label text to derive the legacy mode key 'bpi', which both
-- REFERENCE_NUMBER_PATTERNS (client) and validate_payment_submission()
-- (this trigger, the real "server-side" for this table — the customer
-- payment page inserts into public.payment directly from the browser,
-- there is no FastAPI/Edge Function in that path; see this function's own
-- comment history in 20260716_payment_overhaul.sql) key off — both enforce
-- BPI's own 10-13-alphanumeric-character format specifically, which
-- rejects valid reference numbers from any other bank.
--
-- Fix has two parts:
--   1. Actually rename the row's label, so every UI surface that reads it
--      (Step 1 chip, Step 4 hint/placeholder, the "You are about to
--      submit" summary — all already label-driven, confirmed by reading
--      js/payment.js) shows "Bank Transfer" instead of "BPI".
--   2. Widen this trigger's reference-number rule for that method to a
--      generic, bank-agnostic pattern. GCash/Maya are untouched — those
--      are single-provider formats and stay exactly as they were.
-- ─────────────────────────────────────────────────────────────────────────────

update public.payment_method
set label = 'Bank Transfer'
where type = 'bank' and lower(label) = 'bpi';

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

  -- 'bpi' is kept alongside 'bank' (not replaced) so this is a strict
  -- superset of the old rule — any already-valid BPI-format reference
  -- (10-13 alphanumeric) still passes the new 6-30 alphanumeric-or-hyphen
  -- pattern. New submissions write 'bank' (see resolveLegacyModeKey() in
  -- js/customer_payments.js, no longer specially matches a "bpi" label);
  -- 'bpi' only remains here as a defensive no-op for any row that somehow
  -- still carries the old key.
  if new.reference_number is not null and new.payment_method in ('gcash', 'maya', 'bpi', 'bank') then
    if new.payment_method = 'gcash' and new.reference_number !~ '^[0-9]{13}$' then
      raise exception 'GCash reference number must be exactly 13 digits.';
    elsif new.payment_method = 'maya' and new.reference_number !~ '^[0-9]{12,13}$' then
      raise exception 'Maya reference number must be 12 to 13 digits.';
    elsif new.payment_method in ('bpi', 'bank') and new.reference_number !~ '^[A-Za-z0-9-]{6,30}$' then
      raise exception 'Bank transfer reference number must be 6 to 30 letters, numbers, or hyphens.';
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
