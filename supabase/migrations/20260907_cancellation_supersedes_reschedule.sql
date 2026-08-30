-- Cancellation always supersedes reschedule, enforced server-side (not
-- UI-only) so it can't be bypassed by a direct API call.
--
-- 1. Block a reschedule request from being created while the reservation
--    has an open cancellation request. A trigger (not just RLS) gives a
--    clear, specific error message instead of a bare RLS-violation.
create or replace function public.block_reschedule_when_cancellation_open()
returns trigger as $$
declare
  v_status text;
begin
  select status into v_status from public.reservations where reservation_id = new.reservation_id;
  if v_status in ('cancellation_requested', 'cancellation_approved') then
    raise exception 'A cancellation request is already open for this reservation. Withdraw it before requesting a reschedule.';
  end if;
  return new;
end;
$$ language plpgsql security definer set search_path = public;

drop trigger if exists trg_block_reschedule_when_cancellation_open on public.reschedule_requests;
create trigger trg_block_reschedule_when_cancellation_open
before insert on public.reschedule_requests
for each row execute function public.block_reschedule_when_cancellation_open();

-- 2. The reverse is allowed and wins automatically: submitting a
--    cancellation (reservations.status -> 'cancellation_requested') voids
--    any open reschedule request on the same reservation, and voids any
--    unpaid (pending_review) reschedule_fee payment tied to it so there's
--    no dangling fee row in the ledger. The reservation's own event_date
--    was never touched by the voided reschedule (a reschedule only moves
--    the date once its fee is paid — see js/admin_payments.js's
--    finalize step), so nothing needs to revert there.
create or replace function public.void_reschedule_on_cancellation_request()
returns trigger as $$
begin
  if new.status = 'cancellation_requested' and old.status is distinct from new.status then
    update public.reschedule_requests
      set status = 'voided',
          rejection_reason = 'Superseded by a cancellation request.',
          reviewed_at = now()
      where reservation_id = new.reservation_id
        and status in ('pending', 'approved_pending_payment');

    update public.payment
      set payment_status = 'rejected',
          rejection_reason = 'Voided — this reservation''s cancellation request supersedes the reschedule.',
          verified_at = now()
      where reservation_id = new.reservation_id
        and payment_type = 'reschedule_fee'
        and payment_status = 'pending_review';
  end if;
  return new;
end;
$$ language plpgsql security definer set search_path = public;

drop trigger if exists trg_void_reschedule_on_cancellation_request on public.reservations;
create trigger trg_void_reschedule_on_cancellation_request
after update on public.reservations
for each row execute function public.void_reschedule_on_cancellation_request();

-- 3. Repair reservations that already hold both an open reschedule and an
--    open (or already-approved) cancellation request from before this
--    rule existed — apply the same resolution retroactively. Safe to
--    re-run: the second run matches zero rows.
update public.reschedule_requests rr
set status = 'voided',
    rejection_reason = 'Superseded by a cancellation request.',
    reviewed_at = now()
from public.reservations r
where rr.reservation_id = r.reservation_id
  and r.status in ('cancellation_requested', 'cancellation_approved')
  and rr.status in ('pending', 'approved_pending_payment');

update public.payment p
set payment_status = 'rejected',
    rejection_reason = 'Voided — this reservation''s cancellation request supersedes the reschedule.',
    verified_at = now()
from public.reservations r
where p.reservation_id = r.reservation_id
  and r.status in ('cancellation_requested', 'cancellation_approved')
  and p.payment_type = 'reschedule_fee'
  and p.payment_status = 'pending_review';

-- 4. Customer self-withdraw of their own pending reschedule request —
--    narrowly scoped (only a 'pending' row of their own, only flipping it
--    to 'withdrawn', nothing else) rather than reusing the manager-only
--    update policy from 20260906_reschedule_requests_manager_read_write.sql.
drop policy if exists "customer withdraw own pending reschedule request" on public.reschedule_requests;
create policy "customer withdraw own pending reschedule request"
  on public.reschedule_requests for update
  using (auth.uid() = user_id and status = 'pending')
  with check (auth.uid() = user_id and status = 'withdrawn');
