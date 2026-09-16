-- Auto-complete past reservations directly in the database.
--
-- Previously, a reservation's status only flipped to 'completed' when an
-- admin happened to open Admin > Homepage or Admin > Reports — both call
-- the client-side syncCompletedReservations() (js/reservation_status.js),
-- which fetches past-due, fully-paid reservations and writes
-- status = 'completed' as a side effect of that page load. With no
-- scheduled job behind it, the actual delay between "the event ended" and
-- the row saying 'completed' was just however long it took for an admin to
-- next open one of those two pages.
--
-- This adds the missing scheduled piece: a pg_cron job — same mechanism
-- already running auto_cancel_overdue_reservations() hourly (see
-- 20260716_payment_overhaul.sql) and send_due_reminders() daily (see
-- 20260815_reminder_notifications.sql) — that marks a reservation
-- 'completed' on its own, the first run after the event's date/time has
-- passed, PROVIDED it's paid in full. Mirrors
-- shouldPersistCompletedStatus() in js/reservation_status.js exactly:
-- same eligible-status set (COMPLETABLE_STATUSES, plus 'approved' and
-- 'rescheduled' which reservation_status.js's LEGACY_STATUS_MAP treats as
-- equivalent to 'confirmed'), the same "event passed" definition
-- (Asia/Manila, date, or date + parsed event_time), and the same
-- "outstanding_balance <= 0" payment gate sourced from
-- reservation_payment_summary — the one authoritative balance view (see
-- 20260725_payment_ledger.sql), not a re-derived total. An event-passed-
-- but-unpaid reservation is left untouched here, exactly like the
-- client-side logic — that case is handled entirely by the separate
-- auto_cancel_overdue_reservations() job.
--
-- Runs every 15 minutes rather than hourly (unlike the two jobs above) so
-- "as soon as the event date/time passes" is actually close to true —
-- cheap to run: it's a single set-based UPDATE joined to an existing view,
-- not a per-row loop, and it only touches rows currently sitting in a
-- completable status.
create or replace function public.complete_past_reservations()
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.reservations r
  set status = 'completed'
  from public.reservation_payment_summary s
  where s.reservation_id = r.reservation_id
    and lower(coalesce(r.status, '')) in (
      'approved', 'confirmed', 'rescheduled', 'partially_paid', 'fully_paid'
    )
    and s.outstanding_balance <= 0
    and r.event_date is not null
    and (
      r.event_date < timezone('Asia/Manila', now())::date
      or (
        r.event_date = timezone('Asia/Manila', now())::date
        and coalesce(
          public.parse_event_time_text(r.event_time),
          time '00:00'
        ) <= timezone('Asia/Manila', now())::time
      )
    );
end;
$$;

grant execute on function public.complete_past_reservations() to service_role;

-- Requires the pg_cron extension to be enabled on this project (Database ->
-- Extensions in the Supabase dashboard, or the create extension below if
-- your plan allows creating it from the SQL editor).
create extension if not exists pg_cron;

select cron.unschedule(jobid) from cron.job where jobname = 'complete-past-reservations';
select cron.schedule(
  'complete-past-reservations',
  '*/15 * * * *',
  $$select public.complete_past_reservations();$$
);
