-- Excess payments (a customer sends more than the amount they entered).
--
-- Rule (confirmed with the owner)
--   * Custom amount / down payment / reservation fee, and a balance still
--     remains after the payment: the excess is DEDUCTED from the remaining
--     balance (it is added to the payment's amount, so every existing total,
--     status and overdue check counts it automatically). No return needed.
--   * Full payment, a fee payment (cancellation / reschedule / extension /
--     additional guests), or the excess is bigger than what is left to pay:
--     the part up to the remaining balance is deducted and ONLY the leftover
--     is returned to the customer.
--   * The owner sends the money back outside the system; the manager then
--     marks the record "returned" here. Customers are told it takes 1-2 days.
--
-- How it works
--   * The manager confirms the excess in the Payments review modal (the
--     "Excess" field next to the proof reading), then approves. OCR only
--     suggests a figure; the manager decides.
--   * approve_payment_with_excess() does the whole approval in one transaction:
--     it re-computes the split on the server (the browser's maths is only a
--     preview), writes the payment_excess record, approves the payment with
--     amount = entered amount + deducted part, and sends the notifications.
--   * mark_excess_returned() is how a manager marks the return done.
--   * Admin can READ everything here but cannot approve or mark returns
--     (both functions are manager-only; payment_excess has no write policy).
--
-- payment.amount is raised by the deducted part, so payment_excess keeps the
-- amount the customer originally entered in declared_amount for the audit
-- trail. The returned part never enters payment.amount.
--
-- Deploy: run this file in the Supabase SQL Editor, then push the site. Until
-- it is run, the admin page simply hides the excess records (the lookup is
-- best-effort) and approving without an excess works exactly as before.

-- ── 1. payment_excess ────────────────────────────────────────────────────────
-- payment_id / reservation_id are plain uuids (no foreign keys), the same
-- choice receipt_checks made, so a backup restore or deleted row can never be
-- blocked by this table.
create table if not exists public.payment_excess (
  excess_id        uuid primary key default gen_random_uuid(),
  payment_id       uuid not null unique,
  reservation_id   uuid not null,
  declared_amount  numeric(12,2) not null,
  excess_amount    numeric(12,2) not null check (excess_amount > 0),
  applied_amount   numeric(12,2) not null default 0 check (applied_amount >= 0),
  return_amount    numeric(12,2) not null default 0 check (return_amount >= 0),
  return_status    text not null check (return_status in ('not_needed', 'pending', 'returned')),
  created_by       uuid,
  created_at       timestamptz not null default now(),
  returned_by      uuid,
  returned_at      timestamptz,
  return_note      text,
  constraint payment_excess_split_check check (applied_amount + return_amount = excess_amount),
  constraint payment_excess_status_check check ((return_amount = 0) = (return_status = 'not_needed'))
);

create index if not exists payment_excess_reservation_idx on public.payment_excess (reservation_id);
create index if not exists payment_excess_pending_idx
  on public.payment_excess (created_at) where return_status = 'pending';

alter table public.payment_excess enable row level security;

drop policy if exists "staff read payment excess" on public.payment_excess;
create policy "staff read payment excess" on public.payment_excess
  for select using (public.get_my_role() in ('manager', 'admin'));

drop policy if exists "customer read own payment excess" on public.payment_excess;
create policy "customer read own payment excess" on public.payment_excess
  for select using (
    exists (
      select 1 from public.reservations r
      where r.reservation_id = payment_excess.reservation_id
        and r.user_id = auth.uid()
    )
  );

-- No insert/update/delete policy: rows are written only by the two functions below.
revoke insert, update, delete on public.payment_excess from anon, authenticated;
grant select on public.payment_excess to authenticated;

-- ── 2. approve_payment_with_excess ───────────────────────────────────────────
create or replace function public.approve_payment_with_excess(
  p_payment_id uuid,
  p_excess     numeric
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_pay             public.payment%rowtype;
  v_excess          numeric(12,2);
  v_outstanding     numeric;
  v_remaining_after numeric;
  v_applied         numeric(12,2) := 0;
  v_return          numeric(12,2);
  v_excess_id       uuid;
  v_user_id         uuid;
  v_number          text;
  v_contact         text;
  v_customer_body   text;
begin
  if public.get_my_role() is distinct from 'manager' then
    raise exception 'Only a manager can approve a payment with an excess.';
  end if;

  v_excess := round(coalesce(p_excess, 0), 2);
  if v_excess <= 0 then
    raise exception 'The excess must be more than zero.';
  end if;
  if v_excess > 10000000 then
    raise exception 'That excess is too large.';
  end if;

  select * into v_pay from public.payment where payment_id = p_payment_id for update;
  if not found then
    raise exception 'Payment record could not be found.';
  end if;
  if lower(coalesce(v_pay.payment_status, '')) <> 'pending_review' then
    raise exception 'This payment is not waiting for review.';
  end if;
  if coalesce(v_pay.payment_source::text, '') = 'in_cafe' then
    raise exception 'Payments recorded at the cafe have no excess.';
  end if;
  if exists (select 1 from public.payment_excess where payment_id = p_payment_id) then
    raise exception 'An excess was already recorded for this payment.';
  end if;

  -- Only payments toward the reservation's own price can reduce its balance.
  -- A full payment already settles the whole balance, and fees are not part of
  -- the balance, so their excess is returned in full.
  if v_pay.payment_type::text in ('reservation_fee', 'down_payment', 'partial_payment') then
    select s.outstanding_balance into v_outstanding
    from public.reservation_payment_summary s
    where s.reservation_id = v_pay.reservation_id;

    v_remaining_after := greatest(coalesce(v_outstanding, 0) - v_pay.amount, 0);
    v_applied := round(least(v_excess, v_remaining_after), 2);
  end if;
  v_return := v_excess - v_applied;

  insert into public.payment_excess (
    payment_id, reservation_id, declared_amount, excess_amount,
    applied_amount, return_amount, return_status, created_by
  ) values (
    v_pay.payment_id, v_pay.reservation_id, v_pay.amount, v_excess,
    v_applied, v_return,
    case when v_return > 0 then 'pending' else 'not_needed' end,
    auth.uid()
  )
  returning excess_id into v_excess_id;

  update public.payment
     set payment_status = 'approved',
         verified_at    = now(),
         amount         = amount + v_applied
   where payment_id = p_payment_id;

  select r.user_id, r.reservation_number::text, r.contact_name
    into v_user_id, v_number, v_contact
  from public.reservations r
  where r.reservation_id = v_pay.reservation_id;

  -- Customer: what happened to the extra money.
  if v_user_id is not null then
    if v_applied > 0 and v_return > 0 then
      v_customer_body := 'Your payment was ₱' || to_char(v_excess, 'FM999,999,990.00') || ' more than you entered. '
        || '₱' || to_char(v_applied, 'FM999,999,990.00') || ' was deducted from your remaining balance. '
        || 'The other ₱' || to_char(v_return, 'FM999,999,990.00') || ' will be returned to you within 1–2 days.';
    elsif v_applied > 0 then
      v_customer_body := 'Your payment was ₱' || to_char(v_excess, 'FM999,999,990.00') || ' more than you entered. '
        || 'The extra amount was deducted from your remaining balance.';
    else
      v_customer_body := 'Your payment was ₱' || to_char(v_excess, 'FM999,999,990.00') || ' more than needed. '
        || 'The extra ₱' || to_char(v_return, 'FM999,999,990.00') || ' will be returned to you within 1–2 days.';
    end if;

    insert into public.notifications (user_id, type, title, body, link)
    values (v_user_id, 'payment_excess',
            case when v_return > 0 then 'Extra Payment to Be Returned' else 'Extra Payment Applied' end,
            v_customer_body || coalesce(' (Reservation ' || v_number || ')', ''),
            '/notifications.html');
  end if;

  -- Managers: someone has to send money back. Admin is read-only and is not
  -- alerted; it can still see the record on the Payments page.
  if v_return > 0 then
    insert into public.notifications (user_id, type, title, body, link)
    select p.user_id,
           'payment_excess_return',
           'Excess Payment to Return',
           coalesce(v_contact, 'A customer') || ' sent ₱' || to_char(v_return, 'FM999,999,990.00')
             || ' more than needed' || coalesce(' on reservation ' || v_number, '')
             || '. Return it within 1–2 days, then mark it as returned in Payments.',
           '/admin/payments.html?reservation=' || v_pay.reservation_id::text
    from public.profiles p
    where p.role = 'manager';
  end if;

  return jsonb_build_object(
    'excess_id', v_excess_id,
    'excess',    v_excess,
    'applied',   v_applied,
    'returned',  v_return
  );
end;
$$;

revoke all on function public.approve_payment_with_excess(uuid, numeric) from public, anon;
grant execute on function public.approve_payment_with_excess(uuid, numeric) to authenticated;

-- ── 3. mark_excess_returned ──────────────────────────────────────────────────
create or replace function public.mark_excess_returned(
  p_excess_id uuid,
  p_note      text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row     public.payment_excess%rowtype;
  v_user_id uuid;
  v_number  text;
begin
  if public.get_my_role() is distinct from 'manager' then
    raise exception 'Only a manager can mark an excess as returned.';
  end if;

  select * into v_row from public.payment_excess where excess_id = p_excess_id for update;
  if not found then
    raise exception 'Excess record could not be found.';
  end if;
  if v_row.return_status <> 'pending' then
    raise exception 'This excess is not waiting to be returned.';
  end if;

  update public.payment_excess
     set return_status = 'returned',
         returned_at   = now(),
         returned_by   = auth.uid(),
         return_note   = nullif(left(btrim(coalesce(p_note, '')), 500), '')
   where excess_id = p_excess_id;

  select r.user_id, r.reservation_number::text
    into v_user_id, v_number
  from public.reservations r
  where r.reservation_id = v_row.reservation_id;

  if v_user_id is not null then
    insert into public.notifications (user_id, type, title, body, link)
    values (v_user_id, 'payment_excess',
            'Extra Payment Returned',
            'We sent back ₱' || to_char(v_row.return_amount, 'FM999,999,990.00')
              || ' of your extra payment' || coalesce(' for reservation ' || v_number, '')
              || '. It may take 1–2 days to show in your account.',
            '/notifications.html');
  end if;

  return jsonb_build_object('excess_id', p_excess_id, 'returned', v_row.return_amount);
end;
$$;

revoke all on function public.mark_excess_returned(uuid, text) from public, anon;
grant execute on function public.mark_excess_returned(uuid, text) to authenticated;

-- ── 5. Backup & Restore ──────────────────────────────────────────────────────
-- payment_excess holds money the cafe still has to return, so it is part of the
-- backup (js/admin_backup_tables.js) and of the restorable tables below. This is
-- backup_restore_rows() from 20261121_backup_restore_rows.sql, reproduced
-- verbatim with only 'payment_excess' added to the allowed list.
create or replace function public.backup_restore_rows(
  p_table    text,
  p_rows     jsonb,
  p_conflict text
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_allowed  text[] := array[
    'profiles',
    'staff_roster',
    'package_category',
    'package',
    'package_tier',
    'venue',
    'package_venue',
    'package_photo',
    'badge',
    'package_badge',
    'package_discount',
    'catering_dish_category',
    'catering_dish',
    'catering_section_rule',
    'contract_templates',
    'contract_template_clause',
    'contract_locked_clause',
    'contract_field',
    'event_types',
    'payment_type',
    'payment_method',
    'system_settings',
    'operating_hours',
    'scheduling_settings',
    'scope_capacity',
    'venue_capacity',
    'calendar_blackouts',
    'notification_trigger',
    'notification_template',
    'page_header',
    'gallery_image',
    'about_section',
    'about_value',
    'faq',
    'business_location',
    'business_contact',
    'business_social_link',
    'referral_sources',
    'landing_service',
    'menu_section',
    'menu_banner',
    'announcement',
    'reservations',
    'reservation_contracts',
    'contract_signatures',
    'reservation_staff_assignments',
    'reservation_status',
    'reschedule_requests',
    'payment',
    'payment_excess',
    'reservation_extensions',
    'reservation_additional_head_requests',
    'receipts',
    'reservation_charges',
    'reservation_cancellations',
    'reviews',
    'reservation_forecast'
  ];
  v_oid      regclass;
  v_cols     text[];
  v_conflict text[];
  v_update   text[];
  v_action   text;
  v_sql      text;
  v_count    integer;
begin
  if public.get_my_role() is distinct from 'admin' then
    raise exception 'Only an admin can restore a backup.' using errcode = '42501';
  end if;

  if p_table is null or not (p_table = any(v_allowed)) then
    raise exception 'Table % is not part of the backup.', p_table using errcode = '22023';
  end if;

  if jsonb_typeof(p_rows) is distinct from 'array' or jsonb_array_length(p_rows) = 0 then
    return 0;
  end if;

  v_oid := to_regclass(format('public.%I', p_table));
  if v_oid is null then
    raise exception 'Table % does not exist.', p_table using errcode = '42P01';
  end if;

  -- Columns to write: those present in the saved rows that exist on the table
  -- (computed columns excluded). A GENERATED ALWAYS identity column is NOT
  -- skipped: the insert then fails with Postgres's own message, which the
  -- restore page reports as needing 20261015_backup_restore_support.sql —
  -- better than silently giving restored rows new ids.
  select array_agg(a.attname::text order by a.attnum)
    into v_cols
  from pg_attribute a
  where a.attrelid = v_oid
    and a.attnum > 0
    and not a.attisdropped
    and a.attgenerated = ''
    and exists (select 1 from jsonb_object_keys(p_rows -> 0) k where k = a.attname::text);

  if v_cols is null then
    raise exception 'The rows for % have no known columns.', p_table using errcode = '22023';
  end if;

  v_conflict := string_to_array(replace(coalesce(p_conflict, ''), ' ', ''), ',');
  if coalesce(array_length(v_conflict, 1), 0) = 0
     or exists (select 1 from unnest(v_conflict) c where c = '' or c <> all(v_cols)) then
    raise exception 'Conflict columns (%) must be columns present in the saved rows of %.', p_conflict, p_table
      using errcode = '22023';
  end if;

  select coalesce(array_agg(c), '{}') into v_update
  from unnest(v_cols) c
  where c <> all(v_conflict);

  if cardinality(v_update) = 0 then
    v_action := 'do nothing';
  else
    select 'do update set ' || string_agg(format('%1$I = excluded.%1$I', c), ', ')
      into v_action
    from unnest(v_update) c;
  end if;

  v_sql := format(
    'insert into public.%1$I (%2$s) select %2$s from jsonb_populate_recordset(null::public.%1$I, $1) on conflict (%3$s) %4$s',
    p_table,
    (select string_agg(quote_ident(c), ', ') from unnest(v_cols) c),
    (select string_agg(quote_ident(c), ', ') from unnest(v_conflict) c),
    v_action
  );

  execute format('alter table public.%I disable trigger user', p_table);
  execute v_sql using p_rows;
  get diagnostics v_count = row_count;
  execute format('alter table public.%I enable trigger user', p_table);

  return v_count;
end;
$$;

revoke all on function public.backup_restore_rows(text, jsonb, text) from public, anon;
grant execute on function public.backup_restore_rows(text, jsonb, text) to authenticated;

-- ── 6. Checks (read-only, safe to run) ───────────────────────────────────────
-- Excess still waiting to be returned, oldest first:
--   select e.created_at, r.reservation_number, e.return_amount
--   from public.payment_excess e
--   join public.reservations r on r.reservation_id = e.reservation_id
--   where e.return_status = 'pending' order by e.created_at;
