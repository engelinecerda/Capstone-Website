-- Reschedule requests had no way to record why a manager rejected one —
-- handleRescheduleReview() (js/admin_reservation_details.js) only ever
-- wrote { status: 'rejected', reviewed_at }, no reason. Mirrors the
-- existing public.payment.rejection_reason column/pattern used for
-- payment rejections.
alter table public.reschedule_requests
  add column if not exists rejection_reason text;
