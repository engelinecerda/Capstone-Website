-- Payment Methods & Rules (admin config).
--
-- `payment_method` already exists in the live database (created outside
-- migrations, so its baseline shape is asserted here via IF NOT EXISTS
-- rather than a CREATE TABLE) with columns: payment_method_id, account_name,
-- "phone/account_number", mode_of_payment (free text: GCash/Maya/BPI),
-- qr_image (Cloudinary secure_url), created_at. This migration extends it to
-- a proper bank/ewallet/cash model with an active/inactive lifecycle, folds
-- the old "pay_at_cafe_instructions" cash text into a real row, and adds the
-- RLS this table never had.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 1. New columns ────────────────────────────────────────────────────────────
alter table public.payment_method
  add column if not exists type              text,
  add column if not exists label             text,
  add column if not exists account_number    text,
  add column if not exists phone_number      text,
  add column if not exists cash_window_days  int,
  add column if not exists pay_location      text,
  add column if not exists instructions      text,
  add column if not exists is_active         boolean not null default true,
  add column if not exists sort_order        int not null default 0,
  add column if not exists updated_at        timestamptz not null default now();

-- ── 2. Backfill from the legacy free-text columns ────────────────────────────
update public.payment_method
set
  type = case
    when lower(mode_of_payment) = 'bpi' then 'bank'
    else 'ewallet'
  end,
  label = coalesce(label, mode_of_payment),
  account_number = case when lower(mode_of_payment) = 'bpi' then "phone/account_number" else account_number end,
  phone_number   = case when lower(mode_of_payment) in ('gcash', 'maya') then "phone/account_number" else phone_number end
where type is null and mode_of_payment is not null;

-- ── 3. Fold the old cash instructions into a real method row ─────────────────
insert into public.payment_method (type, label, instructions, cash_window_days, is_active, sort_order)
select
  'cash',
  'Cash on arrival',
  coalesce((select setting_value::jsonb ->> 'cash' from public.system_settings where setting_key = 'pay_at_cafe_instructions'), 'Pay in cash at the counter.'),
  1,
  true,
  999
where not exists (select 1 from public.payment_method where type = 'cash');

-- ── 4. Constraints ────────────────────────────────────────────────────────────
-- Rows that still have no type/label after backfill (shouldn't happen given
-- step 2, but guards against any row inserted with neither mode_of_payment
-- nor a new type) fall back to a safe placeholder rather than failing the
-- NOT NULL below.
update public.payment_method set type = 'ewallet' where type is null;
update public.payment_method set label = 'Unnamed method' where label is null;

alter table public.payment_method
  alter column type set not null,
  alter column label set not null;

alter table public.payment_method
  drop constraint if exists payment_method_type_check;
alter table public.payment_method
  add constraint payment_method_type_check check (type in ('bank', 'ewallet', 'cash'));

alter table public.payment_method
  drop constraint if exists payment_method_fields_by_type;
alter table public.payment_method
  add constraint payment_method_fields_by_type check (
    (type = 'ewallet' and account_name is not null and phone_number is not null) or
    (type = 'bank'    and account_name is not null and account_number is not null) or
    (type = 'cash'    and cash_window_days is not null)
  );

-- ── 5. Drop the now-superseded legacy columns ────────────────────────────────
-- Safe: js/upload_payment_methods.js (the only writer) is removed in this
-- same change, and js/customer_payments.js (the only other reader) is
-- updated to the new columns alongside this migration.
alter table public.payment_method
  drop column if exists mode_of_payment,
  drop column if exists "phone/account_number";

-- ── 6. RLS — this table had none before ──────────────────────────────────────
alter table public.payment_method enable row level security;

drop policy if exists "payment_method_read" on public.payment_method;
create policy "payment_method_read"
  on public.payment_method for select
  using (is_active or get_my_role() = 'admin');

drop policy if exists "payment_method_insert" on public.payment_method;
create policy "payment_method_insert"
  on public.payment_method for insert
  with check (get_my_role() = 'admin');

drop policy if exists "payment_method_update" on public.payment_method;
create policy "payment_method_update"
  on public.payment_method for update
  using (get_my_role() = 'admin')
  with check (get_my_role() = 'admin');

-- No delete policy on purpose — deactivate via is_active instead, so
-- historical payments that reference an old method still resolve.

-- ── 7. Payment Rules — new system_settings singleton ─────────────────────────
-- deposit_pct / full_payment_days already live under system_settings.
-- reservation_rules (see 20260716_payment_overhaul.sql) and are not
-- duplicated here — this key only covers what Reservation Rules doesn't.
insert into public.system_settings (setting_key, setting_value)
values (
  'payment_rules',
  '{"max_installments":2,"auto_hold_enabled":true,"refund_window_days":14,"currency":"PHP"}'
)
on conflict (setting_key) do nothing;
