-- Cancellation workflow (manager-gated approval before a fee is ever
-- generated), matching the existing reschedule_requests pattern
-- (pending -> approved_pending_payment -> completed) but reusing
-- reservations.status instead of a new table, since reservations.status
-- is plain text with no CHECK constraint and notify_admins_on_reservation()
-- already keys off it transitioning INTO 'cancellation_requested'.
--
-- New reservations.status values used from here on:
--   cancellation_requested  -- customer requested, awaiting manager review
--   cancellation_approved   -- manager approved, fee payable, not yet paid
--   cancelled               -- finalized (existing)
-- Rejecting a request reverts reservations.status back to whatever
-- reservation_status recorded as previous_status for the most recent
-- transition INTO cancellation_requested — read and applied in
-- js/admin_reservation_details.js, no schema change needed for that part.
--
-- This migration is written against 20260808_notification_config.sql's
-- template-driven dispatch_notification() system, NOT the older hardcoded
-- CASE-statement version from 20260513 — notify_customer_on_reservation_
-- status() is extended with exactly one new branch, every other branch
-- copied through byte-identical from 20260808's version.

-- ═══════════════════════════════════════════════════════════════════════════
-- 1. reservation_cancellations had no INSERT policy at all — only the
--    SECURITY DEFINER auto_cancel_overdue_reservations() function could
--    write to it. The manual "Finalize cancellation" action needs a real
--    client-side INSERT path, restricted to Manager only (Admin stays
--    read-only, matching the separation-of-duties model already
--    established for reservations/payment in
--    20260714_admin_manager_separation_of_duties.sql).
-- ═══════════════════════════════════════════════════════════════════════════

drop policy if exists "manager insert reservation cancellations" on public.reservation_cancellations;
create policy "manager insert reservation cancellations"
  on public.reservation_cancellations for insert
  with check (
    exists (
      select 1 from public.profiles p
      where p.user_id = auth.uid()
        and p.role = 'manager'
    )
  );

-- ═══════════════════════════════════════════════════════════════════════════
-- 2. New notification trigger_code + template for the one net-new
--    customer-facing message this workflow needs: "your cancellation was
--    approved, pay the fee to finalize." Not disableable, same reasoning
--    20260808 used for cancellation_confirmed/payment_rejected — losing
--    this notice would leave a customer with no idea a fee is now due.
--
--    A "cancellation rejected" message is deliberately NOT added here as a
--    trigger_code/CASE branch — see js/admin_reservation_details.js's
--    reject-cancellation handler, which inserts that notification directly
--    from the client instead. reservations.status after a reject reverts
--    to whatever it was before (commonly 'approved'), which is
--    indistinguishable at the trigger level from a normal transition into
--    that same status — a CASE branch keyed on NEW.status alone cannot
--    tell the two apart, so it can't safely live in this function.
-- ═══════════════════════════════════════════════════════════════════════════

insert into public.notification_trigger (code, label, description, is_disableable, sort_order) values
  ('cancellation_approved', 'Cancellation approved', 'Sent when a manager approves a cancellation request and a fee becomes payable.', false, 7)
on conflict (code) do nothing;

insert into public.notification_template (trigger_code, email_subject, body) values
  ('cancellation_approved', 'Cancellation approved — payment required',
   'Hi {{customer_name}}, your cancellation request for {{event_type}} has been approved. Please pay the cancellation fee to finalize it.')
on conflict (trigger_code) do nothing;

create or replace function public.notify_customer_on_reservation_status()
returns trigger language plpgsql security definer as $$
declare
  v_merge_data jsonb;
begin
  if NEW.status is not distinct from OLD.status then return NEW; end if;

  case NEW.status
    when 'approved' then
      v_merge_data := public.build_notification_merge_data(NEW.reservation_id);
      perform public.dispatch_notification(NEW.user_id, 'reservation_confirmed', 'reservation_status', '/account.html', v_merge_data);
    when 'declined' then
      insert into notifications (user_id, type, title, body, link)
      values (NEW.user_id, 'reservation_status', 'Reservation Not Approved', 'Unfortunately, your reservation was not approved at this time.', '/account.html');
    when 'for_contract_signing' then
      insert into notifications (user_id, type, title, body, link)
      values (NEW.user_id, 'reservation_status', 'Contract Ready to Sign', 'Your reservation is confirmed. Please upload your signed contract to proceed.', '/account.html');
    when 'for_finalization' then
      insert into notifications (user_id, type, title, body, link)
      values (NEW.user_id, 'reservation_status', 'Contract Verified', 'Your signed contract has been verified. Your reservation is now moving to the finalization stage.', '/account.html');
    when 'completed' then
      insert into notifications (user_id, type, title, body, link)
      values (NEW.user_id, 'reservation_status', 'Reservation Complete', 'Your event reservation is now marked complete. Thank you for choosing ELI Coffee Events!', '/account.html');
    when 'cancellation_approved' then
      v_merge_data := public.build_notification_merge_data(NEW.reservation_id);
      perform public.dispatch_notification(NEW.user_id, 'cancellation_approved', 'reservation_status', '/account.html', v_merge_data);
    when 'cancelled' then
      v_merge_data := public.build_notification_merge_data(NEW.reservation_id);
      perform public.dispatch_notification(NEW.user_id, 'cancellation_confirmed', 'reservation_status', '/account.html', v_merge_data);
    else return NEW;
  end case;

  return NEW;
end;
$$;

-- notify_admins_on_reservation() is NOT modified — its existing UPDATE
-- branch already fires on the transition into 'cancellation_requested',
-- which this workflow still uses unchanged as the initial request status.
