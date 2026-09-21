-- Schedule Board: cancelled reservations were only visible on the board
-- for the day they happened to fall on (20260814_board_updated_at_and_
-- cancelled_visibility.sql's `status = 'cancelled' and event_date =
-- current_date` clause) — so a reservation cancelled for later in the
-- board's 7-day week simply never appeared. The board's purpose is to
-- inform staff of the week's schedule and their assignments, so every
-- post-confirmation status (confirmed/approved, partially_paid, fully_paid,
-- rescheduled, cancelled, completed) should show for the whole displayed
-- week — only pre-confirmation stages (pending_review, for_finalization,
-- for_contract_signing) and declined stay excluded, since nothing is
-- locked in yet for those.

drop policy if exists "staff read display-eligible reservations" on public.reservations;
create policy "staff read display-eligible reservations"
  on public.reservations for select
  using (
    get_my_role() = 'staff'
    and status in ('approved', 'confirmed', 'partially_paid', 'fully_paid', 'rescheduled', 'cancelled', 'completed')
  );
