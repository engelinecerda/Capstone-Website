-- Cleanup pass over items flagged-but-deferred across earlier migrations.
-- Each section below is independent; see its own comment for what it
-- addresses and why it was previously left alone.

-- ═══════════════════════════════════════════════════════════════════════════
-- 1. Stale 'super_admin' role check in notify_admins_on_reservation().
--    20260808_notification_config.sql's own comment (line ~278) preserved
--    this byte-for-byte from the original 20260513 migration, noting it
--    wasn't that migration's job to fix. profiles.role has not had a
--    'super_admin' value since 20260624_rename_roles_admin_to_manager.sql
--    (role = 'super_admin' was renamed to 'admin' there) — the OR-clause has
--    been dead for two months, harmless (just an always-false extra
--    condition) but worth closing since we're back in this function anyway.
-- ═══════════════════════════════════════════════════════════════════════════
create or replace function public.notify_admins_on_reservation()
returns trigger language plpgsql security definer as $$
declare
  v_merge_data jsonb;
begin
  if TG_OP = 'INSERT' then
    insert into notifications (user_id, type, title, body, link)
    select user_id,
           'admin_new_reservation',
           'New Reservation Submitted',
           'A customer has submitted a new reservation awaiting your review.',
           '/admin/reservations.html'
    from profiles where role = 'admin';

    v_merge_data := public.build_notification_merge_data(NEW.reservation_id);
    perform public.dispatch_notification(NEW.user_id, 'reservation_submitted', 'reservation_status', '/account.html', v_merge_data);

  elsif TG_OP = 'UPDATE'
    and NEW.status = 'cancellation_requested'
    and (OLD.status is distinct from 'cancellation_requested') then
    insert into notifications (user_id, type, title, body, link)
    select user_id,
           'admin_cancellation_request',
           'Cancellation Requested',
           'A customer has submitted a cancellation request for their reservation.',
           '/admin/reservations.html'
    from profiles where role = 'admin';
  end if;

  return NEW;
end;
$$;

-- ═══════════════════════════════════════════════════════════════════════════
-- 2. system_settings.reservation_rules.full_payment_days existed but nothing
--    read it — the balance-due deadline was hardcoded to "event_date - 7"
--    independently in js/customer_payments.js, auto_cancel_overdue_
--    reservations(), and get_reservation_balance_due_date() (added in
--    20260815_reminder_notifications.sql). All three now read the setting,
--    falling back to 7 if the row/key is missing, so they can never
--    disagree, and changing the setting now actually does something.
-- ═══════════════════════════════════════════════════════════════════════════
create or replace function public.get_full_payment_days()
returns int
language sql
stable
as $$
  select coalesce(
    (
      select (ss.setting_value::jsonb ->> 'full_payment_days')::int
      from public.system_settings ss
      where ss.setting_key = 'reservation_rules'
    ),
    7
  )
$$;

create or replace function public.get_reservation_balance_due_date(p_reservation_id uuid)
returns date
language sql
stable
as $$
  select event_date - public.get_full_payment_days()
  from public.reservations
  where reservation_id = p_reservation_id
$$;

-- Same fix applied to the 4th hardcoded copy: build_notification_merge_data()'s
-- {{pay_by_date}} token (20260815_reminder_notifications.sql). Every other
-- key is byte-identical to that migration's version.
create or replace function public.build_notification_merge_data(p_reservation_id uuid)
returns jsonb
language plpgsql
as $$
declare
  v_data jsonb;
begin
  select jsonb_build_object(
    'customer_name', coalesce(r.contact_name, ''),
    'package_name', coalesce(pk.package_name, ''),
    'event_type', coalesce(r.event_type, 'TBD'),
    'event_date', coalesce(to_char(r.event_date, 'FMMonth FMDD, YYYY'), 'TBD'),
    'event_time', coalesce(r.event_time, 'TBD'),
    'venue', case
      when r.location_type = 'offsite' then coalesce(r.venue_location, 'Customer-provided venue')
      else 'ELI Coffee Events Cafe Binangonan (Onsite)'
    end,
    'reservation_number', coalesce(r.reservation_number, ''),
    'total_price', '₱' || to_char(coalesce(r.total_price, 0), 'FM999,999,990.00'),
    'guest_count', coalesce(r.guest_count::text, ''),
    'amount_paid', '₱' || to_char(coalesce(s.total_paid, 0), 'FM999,999,990.00'),
    'remaining_balance', '₱' || to_char(coalesce(s.outstanding_balance, 0), 'FM999,999,990.00'),
    'pay_by_date', coalesce(to_char(r.event_date - public.get_full_payment_days(), 'FMMonth FMDD, YYYY'), 'TBD')
  )
  into v_data
  from public.reservations r
  left join public.package pk on pk.package_id = r.package_id
  left join public.reservation_payment_summary s on s.reservation_id = r.reservation_id
  where r.reservation_id = p_reservation_id;

  return coalesce(v_data, '{}'::jsonb);
end;
$$;

-- ═══════════════════════════════════════════════════════════════════════════
-- 3. Maintenance Mode's scheduled_start/scheduled_end (20260816_maintenance_
--    mode.sql) existed but were never evaluated anywhere — that migration's
--    comment explicitly deferred them "without also building the scheduler
--    this project doesn't have yet." pg_cron is that scheduler and has been
--    live in this project since 20260716_payment_overhaul.sql; the premise
--    no longer holds, so this wires the auto-flip up.
--
--    One-shot semantics: once a field triggers a flip, it's cleared, so a
--    schedule never re-fires and never fights a later manual toggle. Runs
--    every 5 minutes — tight enough to feel "scheduled," loose enough to
--    stay well inside typical pg_cron minute-level granularity.
-- ═══════════════════════════════════════════════════════════════════════════
create or replace function public.apply_scheduled_maintenance_mode()
returns void
language plpgsql
security definer
as $$
declare
  v_row public.maintenance_mode%rowtype;
begin
  select * into v_row from public.maintenance_mode where id = true;
  if not found then
    return;
  end if;

  if v_row.scheduled_start is not null and not v_row.is_on and now() >= v_row.scheduled_start then
    update public.maintenance_mode
    set is_on = true, turned_on_at = now(), scheduled_start = null
    where id = true;
    v_row.is_on := true;
  end if;

  if v_row.scheduled_end is not null and v_row.is_on and now() >= v_row.scheduled_end then
    update public.maintenance_mode
    set is_on = false, scheduled_end = null
    where id = true;
  end if;
end;
$$;

create extension if not exists pg_cron;

select cron.unschedule(jobid) from cron.job where jobname = 'apply-scheduled-maintenance-mode';
select cron.schedule(
  'apply-scheduled-maintenance-mode',
  '*/5 * * * *',
  $$select public.apply_scheduled_maintenance_mode();$$
);

-- Byte-identical to 20260726_centralize_cancellation_fee.sql's version
-- except v_due_date now calls get_full_payment_days() instead of the
-- literal "- 7" — every other line (the pending-payment guard, cancellation
-- fee insert, reservation_cancellations/reservation_status audit inserts)
-- is unchanged.
create or replace function public.auto_cancel_overdue_reservations()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_auto_cancel_days integer := 5;
  v_rules jsonb;
  v_payment_rules jsonb;
  v_cancel_fee_onsite numeric := 500;
  v_cancel_fee_offsite numeric := 2000;
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

  select setting_value::jsonb into v_payment_rules
  from public.system_settings
  where setting_key = 'payment_rules';

  if v_payment_rules is not null and v_payment_rules ? 'cancellation_fee_onsite' then
    v_cancel_fee_onsite := (v_payment_rules->>'cancellation_fee_onsite')::numeric;
  end if;
  if v_payment_rules is not null and v_payment_rules ? 'cancellation_fee_offsite' then
    v_cancel_fee_offsite := (v_payment_rules->>'cancellation_fee_offsite')::numeric;
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

    v_due_date := v_res.event_date - public.get_full_payment_days();
    v_grace_deadline := v_due_date::timestamptz + (v_auto_cancel_days || ' days')::interval;
    if v_grace_deadline > now() then
      continue;
    end if;

    v_cancellation_fee := case when lower(v_res.location_type) = 'offsite' then v_cancel_fee_offsite else v_cancel_fee_onsite end;

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
