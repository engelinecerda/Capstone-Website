-- Backfill: point existing customer notifications at their reservation.
--
-- OPTIONAL and independent of 20261027 / 20261101. Those fix notifications
-- created from now on; rows already in the table keep whatever link they were
-- given, which for customers is the generic '/notifications.html' (or
-- '/account.html' for the two hold-expiry messages). A notification row has no
-- reservation id, so the reservation has to be inferred, and this does it
-- conservatively: a row is linked only when exactly ONE of the recipient's own
-- reservations fits, and anything ambiguous keeps its current link (it still
-- opens the notifications/account page, exactly as today).
--
--   1. Text names a date  -> the user's reservation whose event date matches
--      (or, for "Reschedule Hold Expired", whose reschedule request asked for
--      that date), if exactly one does.
--   2. No date in the text -> the user's only reservation, if they have
--      exactly one.
--
-- Only link/type-filtered customer rows are touched; is_read and everything
-- else are left alone, and no emails are sent (nothing triggers on UPDATE).
-- Safe to re-run: rows already deep-linked no longer match 'legacy'.
--
-- PREVIEW FIRST: run the SELECT below and check the reservation_number next to
-- each title/body. Then run the UPDATE.

-- ── Preview (read-only) ────────────────────────────────────────────────────
with legacy as (
  -- Customer notifications still carrying a generic link.
  select n.id, n.user_id, n.body
  from public.notifications n
  where n.link in ('/notifications.html', '/account.html')
    and n.type in ('reservation_status', 'payment_status', 'reschedule_review',
                   'payment_due', 'balance_due', 'event_reminder')
),
dated as (
  -- The text names a date: match it against the SAME user's reservations.
  -- Two formats occur: 'October 9, 2026' (templates) and 'October 09, 2026'
  -- (the Cancellation Finalized message).
  select l.id, r.reservation_id
  from legacy l
  join public.reservations r on r.user_id = l.user_id
  where position(to_char(r.event_date::timestamp, 'FMMonth FMDD, YYYY') in l.body) > 0
     or position(to_char(r.event_date::timestamp, 'FMMonth DD, YYYY') in l.body) > 0
  union
  -- "Your hold on <date> expired ..." names the date that was requested in a
  -- reschedule, not the original event date.
  select l.id, rr.reservation_id
  from legacy l
  join public.reservations r on r.user_id = l.user_id
  join public.reschedule_requests rr on rr.reservation_id = r.reservation_id
  where l.body like 'Your hold on %'
    and position(to_char(rr.requested_date::timestamp, 'FMMonth DD, YYYY') in l.body) > 0
),
single_dated as (
  -- Keep only unambiguous date matches.
  select id, (array_agg(reservation_id))[1] as reservation_id
  from dated
  group by id
  having count(distinct reservation_id) = 1
),
single_owner as (
  -- No date in the text (e.g. "Payment received"): only when the user has
  -- exactly one reservation, so there is nothing to confuse it with.
  select l.id, (array_agg(r.reservation_id))[1] as reservation_id
  from legacy l
  join public.reservations r on r.user_id = l.user_id
  where not exists (select 1 from dated d where d.id = l.id)
  group by l.id
  having count(*) = 1
),
resolved as (
  select id, reservation_id from single_dated
  union all
  select id, reservation_id from single_owner
)
select n.created_at, n.title, left(n.body, 70) as body,
       r.reservation_number, r.event_date
from resolved x
join public.notifications n on n.id = x.id
join public.reservations r on r.reservation_id = x.reservation_id
order by n.created_at desc;

-- ── Apply ──────────────────────────────────────────────────────────────────
with legacy as (
  -- Customer notifications still carrying a generic link.
  select n.id, n.user_id, n.body
  from public.notifications n
  where n.link in ('/notifications.html', '/account.html')
    and n.type in ('reservation_status', 'payment_status', 'reschedule_review',
                   'payment_due', 'balance_due', 'event_reminder')
),
dated as (
  -- The text names a date: match it against the SAME user's reservations.
  -- Two formats occur: 'October 9, 2026' (templates) and 'October 09, 2026'
  -- (the Cancellation Finalized message).
  select l.id, r.reservation_id
  from legacy l
  join public.reservations r on r.user_id = l.user_id
  where position(to_char(r.event_date::timestamp, 'FMMonth FMDD, YYYY') in l.body) > 0
     or position(to_char(r.event_date::timestamp, 'FMMonth DD, YYYY') in l.body) > 0
  union
  -- "Your hold on <date> expired ..." names the date that was requested in a
  -- reschedule, not the original event date.
  select l.id, rr.reservation_id
  from legacy l
  join public.reservations r on r.user_id = l.user_id
  join public.reschedule_requests rr on rr.reservation_id = r.reservation_id
  where l.body like 'Your hold on %'
    and position(to_char(rr.requested_date::timestamp, 'FMMonth DD, YYYY') in l.body) > 0
),
single_dated as (
  -- Keep only unambiguous date matches.
  select id, (array_agg(reservation_id))[1] as reservation_id
  from dated
  group by id
  having count(distinct reservation_id) = 1
),
single_owner as (
  -- No date in the text (e.g. "Payment received"): only when the user has
  -- exactly one reservation, so there is nothing to confuse it with.
  select l.id, (array_agg(r.reservation_id))[1] as reservation_id
  from legacy l
  join public.reservations r on r.user_id = l.user_id
  where not exists (select 1 from dated d where d.id = l.id)
  group by l.id
  having count(*) = 1
),
resolved as (
  select id, reservation_id from single_dated
  union all
  select id, reservation_id from single_owner
)
update public.notifications n
set link = '/reservation-details?reservation_id=' || x.reservation_id
from resolved x
where n.id = x.id;
