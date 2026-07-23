-- Payment types & deletable payment methods.
--
-- payment_type: configurable pricing per payment type, replacing hardcoded
-- amounts (reservation fee flat amount, down payment %, custom-amount %)
-- previously baked into js/customer_payments.js and (for the custom-amount
-- minimum only) system_settings.reservation_rules.deposit_pct.
--
-- Code stays 'partial_payment' (not 'custom') — that's the value already
-- live in payment.payment_type rows, the validate_payment_submission()
-- trigger, and several JS files. Label is the display text ("Custom
-- Amount"); code is the stable behavioral key.
create table if not exists public.payment_type (
  id               uuid primary key default gen_random_uuid(),
  code             text not null unique
                     check (code in ('reservation_fee','down_payment','full_payment','partial_payment')),
  label            text not null,
  is_active        boolean not null default true,
  sort_order       int not null default 0,
  flat_amount      numeric(12,2),
  percent_of_total numeric(5,2) check (percent_of_total is null or percent_of_total between 0 and 100),
  min_amount       numeric(12,2),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  constraint pricing_fields_by_code check (
    (code = 'reservation_fee' and flat_amount is not null) or
    (code = 'down_payment'    and percent_of_total is not null) or
    (code = 'full_payment') or
    (code = 'partial_payment' and percent_of_total is not null)
  )
);

-- Seed values match today's real behavior exactly (999 onsite reservation
-- fee, 50% down payment) except partial_payment's 30%, migrated from the
-- live system_settings.reservation_rules.deposit_pct value so no customer
-- sees a different custom-amount minimum the moment this ships.
insert into public.payment_type (code, label, sort_order, flat_amount, percent_of_total, min_amount) values
  ('reservation_fee', 'Reservation fee', 1, 999, null, null),
  ('down_payment',    'Down payment',    2, null, 50,  null),
  ('full_payment',    'Full payment',    3, null, null, null),
  ('partial_payment', 'Custom amount',   4, null, 30,  null)
on conflict (code) do nothing;

alter table public.payment_type enable row level security;

create policy "payment_type_read"
  on public.payment_type for select
  using (is_active or get_my_role() = 'admin');

create policy "payment_type_insert"
  on public.payment_type for insert
  with check (get_my_role() = 'admin');

create policy "payment_type_update"
  on public.payment_type for update
  using (get_my_role() = 'admin')
  with check (get_my_role() = 'admin');

-- No delete policy — the 4 codes are fixed, deactivate via is_active instead.

create or replace function public.set_payment_type_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists trg_payment_type_updated_at on public.payment_type;
create trigger trg_payment_type_updated_at
  before update on public.payment_type
  for each row
  execute function public.set_payment_type_updated_at();

-- Fix 1: payment.payment_method (free-text mode string) has never had a real
-- FK to payment_method.payment_method_id. Add one so a payment_method delete
-- can be safely restricted once it's actually referenced. Nullable and
-- additive — historical payment rows keep their existing free-text
-- payment_method column untouched; only new submissions populate this.
alter table public.payment
  add column if not exists payment_method_id uuid references public.payment_method(payment_method_id) on delete restrict;

create policy "payment_method_delete"
  on public.payment_method for delete
  using (
    get_my_role() = 'admin'
    and not exists (
      select 1 from public.payment p
      where p.payment_method_id = payment_method.payment_method_id
    )
  );

-- Fix 4: the custom-amount ('partial_payment') minimum now reads from
-- payment_type instead of system_settings.reservation_rules.deposit_pct.
-- Everything else in this trigger (reference-number regex checks) is
-- unchanged from supabase/migrations/20260716_payment_overhaul.sql.
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
  v_percent numeric := 30;
  v_floor_amount numeric := 0;
  v_min_amount numeric;
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

    select percent_of_total, coalesce(min_amount, 0) into v_percent, v_floor_amount
    from public.payment_type
    where code = 'partial_payment';
    v_percent := coalesce(v_percent, 30);

    v_min_amount := round(least(greatest(v_total_price * v_percent / 100, v_floor_amount), v_remaining), 2);

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
