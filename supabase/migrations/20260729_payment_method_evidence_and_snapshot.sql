-- Configuration-driven payment recording.
--
-- Formalizes the split that js/customer_payments.js's loadPaymentMethods()
-- already computes ad hoc (type IN ('cash','card') => onsite) into a real,
-- admin-configured column every surface can read directly instead of
-- re-deriving the same type check independently (and inconsistently —
-- js/admin_payments.js's review modal only ever checked for 'cash', never
-- 'card', which this migration's downstream JS changes also fix).
--
-- Run manually in the Supabase SQL Editor per this project's convention.

-- ============================================================
-- 1. payment_method.evidence_source + icon_key
-- ============================================================
alter table public.payment_method
  add column if not exists evidence_source text,
  add column if not exists icon_key text;

update public.payment_method
set evidence_source = case when type in ('cash', 'card') then 'cafe_issued' else 'customer_submitted' end
where evidence_source is null;

update public.payment_method
set icon_key = case type
    when 'cash' then 'cash'
    when 'card' then 'credit-card'
    when 'bank' then 'building-bank'
    when 'ewallet' then 'wallet'
    else 'receipt'
  end
where icon_key is null;

alter table public.payment_method
  alter column evidence_source set not null,
  alter column icon_key set not null,
  alter column icon_key set default 'receipt';

alter table public.payment_method
  drop constraint if exists payment_method_evidence_source_check;
alter table public.payment_method
  add constraint payment_method_evidence_source_check
    check (evidence_source in ('customer_submitted', 'cafe_issued'));

-- evidence_source is derived from type, not independently admin-editable —
-- every live type already maps 1:1 to one evidence source, and letting an
-- admin set them independently (e.g. type='bank' + evidence_source=
-- 'cafe_issued') would break the booking-form branch, the reference-number
-- regex trigger, and the payment_method_fields_by_type CHECK, all of which
-- assume this same mapping. Enforced server-side (not just in the admin
-- JS form) so no future writer can desync them.
create or replace function public.derive_payment_method_evidence_source()
returns trigger
language plpgsql
as $$
begin
  new.evidence_source := case when new.type in ('cash', 'card') then 'cafe_issued' else 'customer_submitted' end;
  return new;
end;
$$;

drop trigger if exists trg_payment_method_evidence_source on public.payment_method;
create trigger trg_payment_method_evidence_source
  before insert or update on public.payment_method
  for each row
  execute function public.derive_payment_method_evidence_source();

-- ============================================================
-- 2. payment.payment_method_label — snapshot at write time
-- ============================================================
-- So a later rename in Payment Options never rewrites already-recorded
-- history. Populated going forward by js/customer_payments.js and
-- js/admin_record_payment.js; backfilled here for existing rows.
alter table public.payment
  add column if not exists payment_method_label text;

update public.payment p
set payment_method_label = pm.label
from public.payment_method pm
where p.payment_method_id = pm.payment_method_id
  and p.payment_method_label is null;

update public.payment
set payment_method_label = case payment_method
    when 'gcash' then 'GCash'
    when 'maya' then 'Maya'
    when 'bpi' then 'BPI'
    when 'card' then 'Card (POS)'
    when 'bank' then 'Bank Transfer'
    when 'ewallet' then 'E-Wallet'
    when 'bancnet' then 'BancNet'
    when 'gcash_maya' then 'GCash/Maya'
    when 'cash' then 'Cash'
    else null
  end
where payment_method_label is null;
