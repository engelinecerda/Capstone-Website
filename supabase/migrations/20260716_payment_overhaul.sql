-- Payment page overhaul: custom down payment, overdue auto-cancellation,
-- and server-side validation for the amount/reference-number rules that
-- were previously only enforced client-side.
--
-- Note on "server-side": the customer payment page inserts into
-- public.payment directly from the browser (no FastAPI/Edge Function in
-- the loop for this table), and the auto-cancellation sweep needs to run
-- continuously in production. Both are implemented natively in Postgres
-- (a BEFORE INSERT trigger + a pg_cron scheduled function) rather than in
-- the Python FastAPI service, which only holds a read-only publishable key
-- and isn't deployed anywhere in this project — see the equivalent note in
-- 20260715_add_agreement_view_tracking.sql for the same reasoning applied
-- to a different feature.

-- ── 1. reservations.cancellation_reason ─────────────────────────────────────
alter table public.reservations
  add column if not exists cancellation_reason text;

-- ── 2. System settings defaults ──────────────────────────────────────────────
-- Mirrors the (previously unwired) "Reservation Rules" panel in
-- admin/super admin/super_admin_settings.html — field IDs there map 1:1 to
-- these JSON keys. deposit_pct drives the Custom Amount minimum; auto_cancel_days
-- drives the overdue grace deadline.
insert into public.system_settings (setting_key, setting_value)
values (
  'reservation_rules',
  '{"min_advance_days":14,"max_advance_days":365,"min_pax":20,"max_pax":150,"deposit_pct":30,"full_payment_days":7,"auto_cancel_days":5,"contract_resubmission_days":3}'
)
on conflict (setting_key) do nothing;

-- Card/Cash need no payment_method account row (unlike GCash/Maya/BPI) —
-- just shared instruction copy, optionally editable by an admin.
insert into public.system_settings (setting_key, setting_value)
values (
  'pay_at_cafe_instructions',
  '{"card":"Card payments are processed on our POS terminal at the counter.","cash":"Pay in cash at the counter."}'
)
on conflict (setting_key) do nothing;

-- ── 3. Server-side payment validation (amount bounds + reference format) ────
-- Reference-number patterns here MUST stay identical to
-- REFERENCE_NUMBER_PATTERNS in js/customer_payments.js — that's the "one
-- client+server validation map" the spec asks for, mirrored across the two
-- languages since a single shared source isn't possible between browser JS
-- and Postgres.
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

drop trigger if exists trg_validate_payment_submission on public.payment;
create trigger trg_validate_payment_submission
  before insert on public.payment
  for each row
  execute function public.validate_payment_submission();

-- ── 4. Overdue auto-cancellation ─────────────────────────────────────────────
-- Grace deadline = (event_date - 7 days) [the existing balance due date] +
-- auto_cancel_days from system_settings. A reservation with an unsubmitted
-- required payment past that deadline is cancelled, with the cancellation
-- fee recorded the same way a customer-initiated cancellation records it
-- (see cancel_own_reservation in 20260418_add_reservation_cancellations.sql).
create or replace function public.auto_cancel_overdue_reservations()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_auto_cancel_days integer := 5;
  v_rules jsonb;
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

    v_cancellation_fee := case when lower(v_res.location_type) = 'offsite' then 2000 else 500 end;

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

grant execute on function public.auto_cancel_overdue_reservations() to service_role;

-- Requires the pg_cron extension to be enabled on this project (Database ->
-- Extensions in the Supabase dashboard, or the create extension below if
-- your plan allows creating it from the SQL editor).
create extension if not exists pg_cron;

select cron.unschedule(jobid) from cron.job where jobname = 'auto-cancel-overdue-reservations';
select cron.schedule(
  'auto-cancel-overdue-reservations',
  '0 * * * *',
  $$select public.auto_cancel_overdue_reservations();$$
);
