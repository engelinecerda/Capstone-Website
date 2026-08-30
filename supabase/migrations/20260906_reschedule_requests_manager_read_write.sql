-- public.reschedule_requests was never created through a tracked migration
-- (no "create table" for it anywhere in supabase/migrations/) — it exists
-- live with whatever RLS was configured directly in the Supabase dashboard,
-- undocumented. Confirmed live: RLS is enabled (an anon-key read returns
-- [] rather than rows or a permission error), and a customer's own INSERT
-- already works (the AFTER INSERT notification trigger from
-- 20260617_fix_notification_routing.sql fires fine, since triggers run
-- with elevated privilege regardless of the row's RLS visibility to the
-- inserting user) — but the manager's reservation-details page reads back
-- zero rows for a request that was genuinely written, even after a hard
-- refresh. The only configuration that explains every one of those facts
-- is a customer-own-row SELECT policy with no manager/admin SELECT policy
-- ever added alongside it, and no manager-scoped UPDATE policy backing the
-- approve/reject controls server-side.
--
-- These only ADD policies (RLS policies are OR'd together), so they can't
-- narrow whatever access already exists — safe to run regardless of the
-- exact current policy shape.
alter table public.reschedule_requests enable row level security;

drop policy if exists "manager admin read reschedule requests" on public.reschedule_requests;
create policy "manager admin read reschedule requests"
  on public.reschedule_requests for select
  using (get_my_role() in ('manager', 'admin'));

-- Manager-only write, matching the client-side guard in
-- handleRescheduleReview (js/admin_reservation_details.js) that already
-- rejects admin with "This action requires the Manager role." — this is
-- the server-side half of that same rule.
drop policy if exists "manager update reschedule requests" on public.reschedule_requests;
create policy "manager update reschedule requests"
  on public.reschedule_requests for update
  using (get_my_role() = 'manager')
  with check (get_my_role() = 'manager');
