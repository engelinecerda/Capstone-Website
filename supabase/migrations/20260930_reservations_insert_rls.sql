-- Reservation identity safeguard (Your Details step redesign — the phone/
-- email fields on that step became customer-editable, so it matters more
-- than ever that a reservation's true *owner* is never something a client
-- can influence).
--
-- Investigation: no migration in this repo's history ever ran `grant
-- insert on public.reservations` or `create policy ... for insert` —
-- public.reservations itself has no tracked `create table` either, so
-- (like reschedule_requests/receipts/reservation_status/
-- reservation_cancellations before it) it was provisioned directly in the
-- Supabase dashboard, with whatever insert grant/policy that involved
-- never captured in a tracked migration. Inserts obviously work in
-- production today (the entire booking flow depends on it), so *something*
-- permits them — this migration doesn't know what that something is, only
-- that it isn't visible here, which is exactly the same blind spot
-- 20260905_reassert_reservations_rls_and_view_invoker.sql found and fixed
-- for this table's SELECT access (RLS was enabled with a correct-looking
-- policy on paper, but a live check showed it wasn't actually being
-- enforced).
--
-- Confirmed live via a direct anon-key REST call: an unauthenticated
-- insert attempt is correctly rejected ("permission denied for table
-- reservations", 401) — so this is not the same "RLS silently not
-- enforced" failure mode. What's NOT independently verified here is
-- whether an *authenticated* user could insert a row with a `user_id`
-- other than their own (no test credentials available to check that
-- directly). This migration closes that gap unconditionally rather than
-- relying on an unverified assumption: if you're applying this via the
-- SQL Editor, open Authentication > Policies for `reservations` first —
-- if an existing insert policy there does NOT check `auth.uid() =
-- user_id`, tighten or remove that one too, since Postgres combines
-- multiple permissive policies for the same command with OR (this new
-- policy can only add a valid path, it can't override a looser one).
grant insert on public.reservations to authenticated;

drop policy if exists "insert own reservations" on public.reservations;
create policy "insert own reservations"
  on public.reservations for insert
  with check (auth.uid() = user_id);
