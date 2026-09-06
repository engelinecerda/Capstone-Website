-- Real, reservation-derived booking counts per package, exposed to the
-- public Packages listing page for its "Most Booked" indicator. The
-- reservations table itself is not directly readable by an anonymous
-- browsing customer for anything beyond aggregate counts, so this is a
-- SECURITY DEFINER function that returns ONLY package_id + a count —
-- never reservation rows, customer names, contact details, or dates.
--
-- A reservation counts toward a package's popularity once it represents a
-- real booking that happened or is still active — pending, approved,
-- confirmed, rescheduled, or completed. Cancelled, declined, and
-- cancellation_approved reservations never happened (or were reversed) and
-- must not count.
create or replace function public.get_package_booking_counts()
returns table(package_id uuid, booking_count integer)
language sql
security definer
set search_path = public
as $$
  select r.package_id, count(*)::integer as booking_count
  from public.reservations r
  where r.package_id is not null
    and r.status in ('pending', 'approved', 'confirmed', 'rescheduled', 'completed')
  group by r.package_id;
$$;

grant execute on function public.get_package_booking_counts() to anon, authenticated;
