-- Reminder Notifications (Notifications Phase 2).
--
-- Extends 20260808_notification_config.sql — reuses notification_trigger,
-- notification_template, render_notification_template(),
-- build_notification_merge_data(), and dispatch_notification() exactly as
-- they are. Nothing about the Phase 1 catalogue (the 6 event-driven
-- triggers) changes here; this only adds 3 more rows to it and the
-- scheduled sweep that's the one piece Phase 1 didn't have.
--
-- Scheduler: pg_cron is already installed and already running a job in
-- this project (auto-cancel-overdue-reservations, hourly — see
-- 20260716_payment_overhaul.sql). The "no scheduled job exists yet" note
-- on admin/config/notifications.html was written before that was true, or
-- just missed it — either way, no new infra is needed here, just a second
-- cron.schedule() call following the exact same pattern.
--
-- Payment-due vs balance-due: there is no separate "pay-by date" for the
-- initial reservation payment anywhere in this codebase — only the full-
-- settlement deadline (event_date - 7) exists, hardcoded identically in
-- js/customer_payments.js's PAYMENT_BALANCE_DUE_DAYS and in
-- auto_cancel_overdue_reservations() (20260726_centralize_cancellation_
-- fee.sql). Confirmed with the user: both reminders key off that same
-- deadline, distinguished by reservation_payment_summary.computed_status
-- ('unpaid' vs 'partially_paid') rather than inventing a second, unrelated
-- due date. get_reservation_balance_due_date() below is that deadline,
-- factored into one place instead of adding a 3rd hardcoded copy of "-7".

-- ═══════════════════════════════════════════════════════════════════════════
-- 1. SCHEMA
-- ═══════════════════════════════════════════════════════════════════════════

-- Null/ignored for Phase 1's immediate triggers; set for reminders.
alter table public.notification_template
  add column if not exists lead_days int check (lead_days is null or lead_days >= 0);

insert into public.notification_trigger (code, label, description, is_disableable, sort_order) values
  ('payment_due',    'Payment due reminder', 'Sent a set number of days before payment is due, if nothing has been paid yet.', true, 7),
  ('balance_due',    'Balance due reminder', 'Sent a set number of days before the full balance is due, if a balance remains.', true, 8),
  ('event_reminder', 'Event reminder',       'Sent a set number of days before the event date.', true, 9)
on conflict (code) do nothing;

insert into public.notification_template (trigger_code, is_enabled, send_in_app, send_email, email_subject, body, lead_days) values
  ('payment_due', true, true, true, 'Payment due soon',
   'Hi {{customer_name}}, this is a reminder that payment for your {{event_type}} reservation on {{event_date}} is due by {{pay_by_date}}. Amount due: {{remaining_balance}}.',
   3),
  ('balance_due', true, true, true, 'Balance due soon',
   'Hi {{customer_name}}, your remaining balance of {{remaining_balance}} for your {{event_type}} reservation on {{event_date}} is due by {{pay_by_date}}. Please settle it to avoid cancellation.',
   3),
  ('event_reminder', true, true, true, 'Your event is coming up',
   'Hi {{customer_name}}, just a reminder that your {{event_type}} reservation is coming up on {{event_date}} at {{event_time}}. We look forward to seeing you!',
   1)
on conflict (trigger_code) do nothing;

-- The idempotency ledger — "this reminder, for this reservation, for this
-- occurrence" is exactly (reservation_id, reminder_type, target_date). The
-- unique constraint is the actual enforcement; the pre-insert lookup the
-- sweep does below is just what decides whether to bother dispatching.
create table if not exists public.reminder_sent (
  id             uuid primary key default gen_random_uuid(),
  reservation_id uuid not null references public.reservations(reservation_id) on delete cascade,
  reminder_type  text not null,
  target_date    date not null,
  sent_at        timestamptz not null default now(),
  channel        text,
  unique (reservation_id, reminder_type, target_date)
);

create index if not exists reminder_sent_reservation_idx on public.reminder_sent (reservation_id);

alter table public.reminder_sent enable row level security;
drop policy if exists "Admin read reminder ledger" on public.reminder_sent;
create policy "Admin read reminder ledger" on public.reminder_sent for select using (get_my_role() = 'admin');
-- No insert/update/delete policy for anyone — only send_due_reminders()
-- (security definer) writes here, same as notifications' own dispatch path.

-- ═══════════════════════════════════════════════════════════════════════════
-- 2. HELPERS
-- ═══════════════════════════════════════════════════════════════════════════

create or replace function public.get_reservation_balance_due_date(p_reservation_id uuid)
returns date
language sql
stable
as $$
  -- Mirrors js/customer_payments.js's PAYMENT_BALANCE_DUE_DAYS (=7) and
  -- auto_cancel_overdue_reservations()'s v_due_date := v_res.event_date - 7.
  -- Both hardcode 7 rather than reading system_settings.reservation_rules.
  -- full_payment_days (a pre-existing drift, not introduced or fixed here)
  -- — matching them exactly keeps this the same deadline the customer
  -- already sees on account.html and is actually bound by.
  select event_date - 7 from public.reservations where reservation_id = p_reservation_id
$$;

-- Adds pay_by_date to the existing merge-data payload — purely additive,
-- every other key is unchanged, so this is safe for the 6 Phase 1 triggers
-- (none of their templates reference {{pay_by_date}}, so the extra key is
-- simply unused for them).
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
    'pay_by_date', coalesce(to_char(r.event_date - 7, 'FMMonth FMDD, YYYY'), 'TBD')
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
-- 3. THE SWEEP — runs daily via pg_cron. Safe to run more than once a day:
--    every send is gated by an ON CONFLICT DO NOTHING insert into
--    reminder_sent, so a re-run (or an overlapping run) only ever inserts
--    the ledger row once and only dispatches for the run that wins it.
--    Each reminder re-checks current state (payment/cancellation status) at
--    send time, not at any earlier point, so an already-paid/cancelled
--    reservation never gets a stale reminder.
-- ═══════════════════════════════════════════════════════════════════════════

create or replace function public.send_due_reminders()
returns void
language plpgsql
security definer
as $$
declare
  v_template   public.notification_template%rowtype;
  v_row        record;
  v_target_date date;
  v_ledger_id  uuid;
  v_merge_data jsonb;
  v_channel    text;
begin
  -- Payment due — nothing paid yet, settlement deadline approaching.
  select * into v_template from public.notification_template where trigger_code = 'payment_due';
  if found and v_template.is_enabled then
    for v_row in
      select r.reservation_id, r.user_id
      from public.reservations r
      join public.reservation_payment_summary s on s.reservation_id = r.reservation_id
      where public.is_capacity_blocking_reservation_status(r.status)
        and s.computed_status = 'unpaid'
        and r.event_date is not null
        and public.get_reservation_balance_due_date(r.reservation_id) - coalesce(v_template.lead_days, 3) = current_date
    loop
      v_target_date := public.get_reservation_balance_due_date(v_row.reservation_id);
      v_channel := case
        when v_template.send_in_app and v_template.send_email then 'in_app,email'
        when v_template.send_email then 'email'
        when v_template.send_in_app then 'in_app'
        else null
      end;

      insert into public.reminder_sent (reservation_id, reminder_type, target_date, channel)
      values (v_row.reservation_id, 'payment_due', v_target_date, v_channel)
      on conflict (reservation_id, reminder_type, target_date) do nothing
      returning id into v_ledger_id;

      if v_ledger_id is not null then
        v_merge_data := public.build_notification_merge_data(v_row.reservation_id);
        perform public.dispatch_notification(v_row.user_id, 'payment_due', 'payment_due', '/account.html', v_merge_data);
      end if;
    end loop;
  end if;

  -- Balance due — partial payment made, balance remains, same deadline.
  select * into v_template from public.notification_template where trigger_code = 'balance_due';
  if found and v_template.is_enabled then
    for v_row in
      select r.reservation_id, r.user_id
      from public.reservations r
      join public.reservation_payment_summary s on s.reservation_id = r.reservation_id
      where public.is_capacity_blocking_reservation_status(r.status)
        and s.computed_status = 'partially_paid'
        and r.event_date is not null
        and public.get_reservation_balance_due_date(r.reservation_id) - coalesce(v_template.lead_days, 3) = current_date
    loop
      v_target_date := public.get_reservation_balance_due_date(v_row.reservation_id);
      v_channel := case
        when v_template.send_in_app and v_template.send_email then 'in_app,email'
        when v_template.send_email then 'email'
        when v_template.send_in_app then 'in_app'
        else null
      end;

      insert into public.reminder_sent (reservation_id, reminder_type, target_date, channel)
      values (v_row.reservation_id, 'balance_due', v_target_date, v_channel)
      on conflict (reservation_id, reminder_type, target_date) do nothing
      returning id into v_ledger_id;

      if v_ledger_id is not null then
        v_merge_data := public.build_notification_merge_data(v_row.reservation_id);
        perform public.dispatch_notification(v_row.user_id, 'balance_due', 'balance_due', '/account.html', v_merge_data);
      end if;
    end loop;
  end if;

  -- Event reminder — reservation still active, event date approaching.
  select * into v_template from public.notification_template where trigger_code = 'event_reminder';
  if found and v_template.is_enabled then
    for v_row in
      select r.reservation_id, r.user_id, r.event_date
      from public.reservations r
      where public.is_capacity_blocking_reservation_status(r.status)
        and r.event_date is not null
        and r.event_date - coalesce(v_template.lead_days, 1) = current_date
    loop
      v_channel := case
        when v_template.send_in_app and v_template.send_email then 'in_app,email'
        when v_template.send_email then 'email'
        when v_template.send_in_app then 'in_app'
        else null
      end;

      insert into public.reminder_sent (reservation_id, reminder_type, target_date, channel)
      values (v_row.reservation_id, 'event_reminder', v_row.event_date, v_channel)
      on conflict (reservation_id, reminder_type, target_date) do nothing
      returning id into v_ledger_id;

      if v_ledger_id is not null then
        v_merge_data := public.build_notification_merge_data(v_row.reservation_id);
        perform public.dispatch_notification(v_row.user_id, 'event_reminder', 'event_reminder', '/account.html', v_merge_data);
      end if;
    end loop;
  end if;
end;
$$;

-- ═══════════════════════════════════════════════════════════════════════════
-- 4. SCHEDULE — daily at 1am UTC = 9am Philippine time (UTC+8), a customer-
--    friendly send hour. Same re-schedule pattern as auto-cancel-overdue-
--    reservations (20260716_payment_overhaul.sql) so this migration stays
--    safe to re-run.
-- ═══════════════════════════════════════════════════════════════════════════

create extension if not exists pg_cron;

select cron.unschedule(jobid) from cron.job where jobname = 'send-due-reminders';
select cron.schedule(
  'send-due-reminders',
  '0 1 * * *',
  $$select public.send_due_reminders();$$
);
