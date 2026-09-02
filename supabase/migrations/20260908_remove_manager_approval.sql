-- update-v20: remove manager approval from reschedule and cancellation.
-- The manager can't legitimately refuse either (a cancellation is the
-- customer leaving; a reschedule date is already availability-checked
-- before submission), so both become immediate/self-service, with the
-- manager's role narrowed to verifying the fee payment plus visibility
-- (see the Dashboard/Reservations alert banner, built client-side).

-- 1. Cancellation fees were previously only ever inserted by a manager's
--    approve-cancellation action (js/admin_reservation_details.js). The
--    new confirm-and-settle flow inserts this row directly from the
--    customer's own cancellation submission (js/account.js,
--    js/reservation_details.js) — narrowly scoped, matching the existing
--    "manager insert cancellation_fee" pattern from
--    20260903_manager_insert_cancellation_fee.sql but for the customer's
--    own reservation instead.
drop policy if exists "customer insert own cancellation fee" on public.payment;
create policy "customer insert own cancellation fee"
  on public.payment for insert
  with check (
    payment_type = 'cancellation_fee'
    and payment_status = 'pending_review'
    and exists (
      select 1 from public.reservations r
      where r.reservation_id = payment.reservation_id
        and r.user_id = auth.uid()
    )
  );

-- 2. Reschedule requests no longer pass through a 'pending' (awaiting
--    manager) state — submission goes straight to 'approved_pending_payment'
--    since the calendar already guarantees the date is valid. Broaden the
--    customer self-withdraw policy from 20260907 (which only covered
--    'pending') to also cover this new pre-payment state.
drop policy if exists "customer withdraw own pending reschedule request" on public.reschedule_requests;
create policy "customer withdraw own pending reschedule request"
  on public.reschedule_requests for update
  using (auth.uid() = user_id and status in ('pending', 'approved_pending_payment'))
  with check (auth.uid() = user_id and status = 'withdrawn');

-- 3. Repair: reservations stuck in the old pending-approval states from
--    before this change.
--
--    Reschedule: enforce_reschedule_capacity() (20260813_reschedule_
--    advance_notice.sql) re-validates advance-notice/closed-day/capacity
--    on every UPDATE to reschedule_requests, not just INSERT — a plain
--    bulk UPDATE here re-triggers it, and since time has passed since
--    these were originally submitted, a date that was valid then can
--    legitimately fail now (this is what surfaced the "This date is too
--    soon" error on the first run of this migration). Handled per-row:
--    if the transition still validates, it proceeds to awaiting-fee; if
--    the trigger now rejects it for any reason, that row is marked
--    rejected with the trigger's own message as the reason instead of
--    aborting the whole migration — computeCanReschedule (js/reservation_
--    shared.js) already treats 'rejected' as not-open, so the customer
--    can immediately submit a fresh request for a valid date.
do $$
declare
  req record;
begin
  for req in select reschedule_request_id from public.reschedule_requests where status = 'pending' loop
    begin
      update public.reschedule_requests
      set status = 'approved_pending_payment',
          reviewed_at = now()
      where reschedule_request_id = req.reschedule_request_id;
    exception when others then
      update public.reschedule_requests
      set status = 'rejected',
          rejection_reason = 'This date no longer meets booking requirements (' || sqlerrm || '). Please submit a new reschedule request.',
          reviewed_at = now()
      where reschedule_request_id = req.reschedule_request_id;
    end;
  end loop;
end;
$$;

-- Cancellation: unaffected by an equivalent problem — enforce_reservation_
-- capacity() (20260803_reservation_location_type_integrity.sql) only runs
-- its overlap/capacity checks when new.status is in ('pending', 'approved',
-- 'confirmed', 'rescheduled'); 'cancellation_approved' isn't in that list,
-- so the update below already exits that trigger early. A cancellation_
-- requested reservation had already committed to cancelling — reason
-- already stored — so it moves straight to awaiting-fee, inserting the fee
-- row the customer flow now creates itself. Safe to re-run: the second run
-- matches zero rows.

with stuck as (
  select reservation_id from public.reservations where status = 'cancellation_requested'
)
update public.reservations r
set status = 'cancellation_approved'
from stuck
where r.reservation_id = stuck.reservation_id;

insert into public.payment (reservation_id, payment_type, amount, payment_status, submitted_at)
select r.reservation_id,
       'cancellation_fee',
       case when lower(coalesce(r.location_type, '')) = 'offsite' then
         coalesce((select (setting_value::jsonb->>'cancellation_fee_offsite')::numeric from public.system_settings where setting_key = 'payment_rules'), 2000)
       else
         coalesce((select (setting_value::jsonb->>'cancellation_fee_onsite')::numeric from public.system_settings where setting_key = 'payment_rules'), 500)
       end,
       'pending_review',
       now()
from public.reservations r
where r.status = 'cancellation_approved'
  and not exists (
    select 1 from public.payment p
    where p.reservation_id = r.reservation_id and p.payment_type = 'cancellation_fee'
  );

-- 4. "Seen" tracking for the manager alert banner (item 5) — set whenever
--    a manager clicks "Review" on the banner; a reservation counts toward
--    the banner again only once it changes further after this timestamp.
alter table public.reservations add column if not exists change_seen_at timestamptz;
