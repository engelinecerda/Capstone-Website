-- Receipt validation before payment submission (phases 1 and 3).
--
-- What this adds
--   * payment_method.receipt_name_aliases - extra names a receipt may show for
--     the designated receiver (e.g. the owner's personal name for a business
--     wallet), used by the validate-receipt edge function.
--   * receipt_checks - one row per pre-submission receipt check, written ONLY
--     by the validate-receipt edge function (service role). Staff can read it.
--   * payment.receipt_check_id / receipt_check_status - which check a payment
--     was submitted with, and its verdict: passed, needs_review, mismatch,
--     or missing (no check found). Set by the trigger below, never by the
--     client.
--   * trg_zz_payment_receipt_check - the server-side gate on customer
--     payment inserts. Behaviour follows system_settings
--     'receipt_validation_mode':
--         off      does nothing
--         warn     records the verdict on the payment, never blocks (DEFAULT)
--         enforce  rejects a payment with a mismatched receipt, no stored
--                  check, or a reference number already used
--
-- Only customer self-service submissions on customer_submitted methods are
-- gated. In-cafe/staff-recorded payments, manager/admin inserts and the
-- cancellation-fee system job pass straight through, exactly as in
-- validate_payment_submission.
--
-- Nothing in the website calls validate-receipt yet (that is the customer-
-- page phase), so until then WARN simply tags new payments 'missing'.
--
-- To switch modes (Supabase SQL Editor):
--   update public.system_settings set setting_value = 'enforce'
--   where setting_key = 'receipt_validation_mode';
--
-- Deploy order: run this migration, deploy the validate-receipt function
-- (npx supabase functions deploy validate-receipt), then push the site.

-- ── 1. Name aliases on payment methods ───────────────────────────────────────
alter table public.payment_method
  add column if not exists receipt_name_aliases text[] not null default '{}';

comment on column public.payment_method.receipt_name_aliases is
  'Additional receiver names a receipt may show for this method (e.g. the account owner''s personal name). Compared by validate-receipt alongside account_name.';

-- ── 2. receipt_checks ────────────────────────────────────────────────────────
-- user_id and payment.receipt_check_id are plain uuids (no foreign keys) so a
-- backup restore or a deleted account can never be blocked by this table.
create table if not exists public.receipt_checks (
  check_id          uuid primary key default gen_random_uuid(),
  user_id           uuid not null,
  payment_method_id uuid not null references public.payment_method(payment_method_id) on delete cascade,
  proof_url         text not null,
  expected          jsonb not null,
  extracted         jsonb,
  fields            jsonb not null default '{}'::jsonb,
  verdict           text not null check (verdict in ('pass', 'mismatch', 'needs_review')),
  reasons           text[] not null default '{}',
  mode              text not null,
  used_at           timestamptz,
  created_at        timestamptz not null default now()
);

create index if not exists receipt_checks_user_recent_idx
  on public.receipt_checks (user_id, created_at desc);

alter table public.receipt_checks enable row level security;

drop policy if exists "staff read receipt checks" on public.receipt_checks;
create policy "staff read receipt checks" on public.receipt_checks
  for select using (public.get_my_role() in ('manager', 'admin'));

-- No insert/update/delete policies: only the service role (the edge function
-- and the trigger below) writes here.
revoke insert, update, delete on public.receipt_checks from anon, authenticated;

-- ── 3. Snapshot on the payment ───────────────────────────────────────────────
alter table public.payment
  add column if not exists receipt_check_id uuid,
  add column if not exists receipt_check_status text;

alter table public.payment
  drop constraint if exists payment_receipt_check_status_check;
alter table public.payment
  add constraint payment_receipt_check_status_check
  check (receipt_check_status is null or receipt_check_status in ('passed', 'needs_review', 'mismatch', 'missing'));

-- ── 4. Mode setting (default warn) ───────────────────────────────────────────
insert into public.system_settings (setting_key, setting_value)
select 'receipt_validation_mode', 'warn'
where not exists (
  select 1 from public.system_settings where setting_key = 'receipt_validation_mode'
);

-- ── 5. The gate ──────────────────────────────────────────────────────────────
create or replace function public.enforce_receipt_check()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_evidence  text;
  v_mode      text;
  v_norm_ref  text;
  v_check     public.receipt_checks%rowtype;
begin
  -- Same bypasses as validate_payment_submission: staff-recorded, system
  -- jobs (no logged-in user) and manager/admin inserts are not customer
  -- self-service.
  if new.payment_source = 'in_cafe' then
    return new;
  end if;
  if auth.uid() is null then
    return new;
  end if;
  if public.get_my_role() in ('manager', 'admin') then
    return new;
  end if;
  if new.payment_method_id is null then
    return new;
  end if;

  -- Only methods where the customer uploads their own evidence.
  select evidence_source into v_evidence
  from public.payment_method
  where payment_method_id = new.payment_method_id;

  if v_evidence is distinct from 'customer_submitted' then
    return new;
  end if;

  select setting_value into v_mode
  from public.system_settings
  where setting_key = 'receipt_validation_mode';

  v_mode := lower(btrim(coalesce(v_mode, 'warn'), ' "'));
  if v_mode not in ('off', 'warn', 'enforce') then
    v_mode := 'warn';
  end if;

  -- These two columns are server-owned: never trust what the client sent.
  new.receipt_check_id := null;
  new.receipt_check_status := null;

  if v_mode = 'off' then
    return new;
  end if;

  v_norm_ref := upper(regexp_replace(coalesce(new.reference_number, ''), '[^A-Za-z0-9]', '', 'g'));

  -- The same transfer reference can't back two live payments.
  if v_mode = 'enforce' and v_norm_ref <> '' and exists (
    select 1
    from public.payment p
    where p.payment_method_id = new.payment_method_id
      and p.payment_status in ('pending_review', 'approved')
      and upper(regexp_replace(coalesce(p.reference_number, ''), '[^A-Za-z0-9]', '', 'g')) = v_norm_ref
  ) then
    raise exception 'This reference number has already been used for another payment.';
  end if;

  -- A fresh, unused check for THIS user, THIS receipt image and the values
  -- actually being submitted. FOR UPDATE stops one check being used by two
  -- concurrent submissions.
  select * into v_check
  from public.receipt_checks c
  where c.user_id = auth.uid()
    and c.payment_method_id = new.payment_method_id
    and c.proof_url = new.proof_url
    and c.used_at is null
    and c.created_at > now() - interval '30 minutes'
    and c.expected ->> 'reference' = v_norm_ref
    and left(c.expected ->> 'payment_date', 10) = left(coalesce(new.payment_date::text, ''), 10)
    and round((c.expected ->> 'amount')::numeric, 2) = round(new.amount, 2)
  order by c.created_at desc
  limit 1
  for update;

  if not found then
    new.receipt_check_status := 'missing';
    if v_mode = 'enforce' then
      raise exception 'Your receipt needs to be checked before this payment can be submitted. Please try again.';
    end if;
    return new;
  end if;

  new.receipt_check_id := v_check.check_id;
  new.receipt_check_status := case v_check.verdict
    when 'pass' then 'passed'
    when 'needs_review' then 'needs_review'
    else 'mismatch'
  end;

  if v_mode = 'enforce' and v_check.verdict = 'mismatch' then
    raise exception 'Your receipt does not match this payment: %', array_to_string(v_check.reasons, ' ');
  end if;

  update public.receipt_checks set used_at = now() where check_id = v_check.check_id;
  return new;
end;
$$;

-- Named so it fires AFTER trg_block_payment_during_maintenance and
-- trg_validate_payment_submission (BEFORE triggers run alphabetically): the
-- existing eligibility checks reject first, and a check is only consumed for
-- a payment that is actually going in (an exception rolls the use back).
drop trigger if exists trg_zz_payment_receipt_check on public.payment;
create trigger trg_zz_payment_receipt_check
  before insert on public.payment
  for each row execute function public.enforce_receipt_check();
