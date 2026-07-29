-- Add a 'card' payment_method type: pay via the cafe's POS terminal
-- on-site — the same onsite flow as cash (customer picks an arrival date,
-- no reference number or proof upload; staff confirms it in person).
-- Reuses cash_window_days ("latest pay-by, days before event") since that
-- column already means "how long before the event this onsite option stays
-- bookable", which applies just as well to card as to cash.
alter table public.payment_method
  drop constraint if exists payment_method_type_check,
  add constraint payment_method_type_check check (type in ('bank', 'ewallet', 'cash', 'card'));

alter table public.payment_method
  drop constraint if exists payment_method_fields_by_type,
  add constraint payment_method_fields_by_type check (
    (type = 'ewallet' and account_name is not null and phone_number is not null) or
    (type = 'bank'    and account_name is not null and account_number is not null) or
    (type in ('cash', 'card') and cash_window_days is not null)
  );
