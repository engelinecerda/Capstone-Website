-- 20261031_admin_reservations_server_pagination.sql
--
-- Server-side pagination, filtering and search for the admin Reservations
-- page (js/admin_reservations.js).
--
-- Before: every page load and every 60-second auto-refresh downloaded ALL
-- reservations, then ALL payments for them (every column, including notes and
-- proof URLs), ALL contracts, ALL reschedule requests, ALL payment summaries
-- and ALL staff assignments - and the page then filtered, searched, counted
-- and paged them in the browser. The page never even displayed the payments,
-- contracts or reschedule requests it downloaded.
--
-- After: the browser asks for one page of 25 reservations, already filtered
-- and searched in the database, and loads the stat-card / chip counts in one
-- small separate call.
--
-- Everything here is SECURITY INVOKER (same choice as get_admin_nav_counts()
-- and get_admin_customers_page()): the functions run with the caller's own
-- permissions, so row-level security applies exactly as it did for the old
-- direct queries. A customer calling them would only ever see their own
-- reservations. They grant no extra visibility.
--
-- ----------------------------------------------------------------------------
-- "Effective status"
-- ----------------------------------------------------------------------------
-- The page never showed the raw reservations.status. It showed an "effective"
-- status computed in the browser (getEffectiveReservationStatus):
--   * completed / cancelled / declined stay as they are
--   * an approved / confirmed / rescheduled reservation whose event has
--     already started AND whose outstanding balance is <= 0 counts as
--     'completed' (complete_past_reservations() persists the same rule every
--     15 minutes; this makes the page right in between runs)
--   * 'confirmed' is shown as 'approved'
--   * anything else is shown as stored (lower-cased; empty = 'pending')
-- Filters, chip counts and stat cards were all based on that value, so the
-- database needs the same rule. It lives in ONE function below and is used by
-- both RPCs, so the counts and the filtered list can never disagree.
--
-- "Event has started" uses Asia/Manila, the same business time zone
-- complete_past_reservations() and get_admin_dashboard_stats() use.
-- "Upcoming" = event_date is today or later (Asia/Manila) and the effective
-- status is pending, approved or rescheduled - the same rule the browser used.

create or replace function public.reservation_effective_status(
  p_status         text,
  p_event_date     date,
  p_event_time     text,
  p_reservation_id uuid
)
returns text
language sql
stable
security invoker
set search_path = public
as $$
  select case
    when lower(coalesce(nullif(p_status, ''), 'pending')) in ('completed', 'cancelled', 'declined')
      then lower(coalesce(nullif(p_status, ''), 'pending'))
    when lower(coalesce(nullif(p_status, ''), 'pending')) in ('approved', 'confirmed', 'rescheduled')
         and p_event_date is not null
         and (
           p_event_date < (now() at time zone 'Asia/Manila')::date
           or (
             p_event_date = (now() at time zone 'Asia/Manila')::date
             and coalesce(public.parse_event_time_text(p_event_time), time '00:00')
                 <= (now() at time zone 'Asia/Manila')::time
           )
         )
         and exists (
           select 1
             from public.reservation_payment_summary s
            where s.reservation_id = p_reservation_id
              and s.outstanding_balance <= 0
         )
      then 'completed'
    when lower(coalesce(nullif(p_status, ''), 'pending')) = 'confirmed'
      then 'approved'
    else lower(coalesce(nullif(p_status, ''), 'pending'))
  end;
$$;

revoke all on function public.reservation_effective_status(text, date, text, uuid) from public, anon;
grant execute on function public.reservation_effective_status(text, date, text, uuid) to authenticated;


-- ----------------------------------------------------------------------------
-- Counts for the stat cards, the status chips and the sidebar badge.
-- They always describe ALL reservations (never the current search), so the
-- page loads them on its own, only on a full load / auto-refresh.
-- ----------------------------------------------------------------------------
create or replace function public.get_admin_reservation_counts()
returns jsonb
language sql
stable
security invoker
set search_path = public
as $$
  with s as (
    select r.event_date,
           public.reservation_effective_status(
             r.status, r.event_date, r.event_time, r.reservation_id
           ) as eff
      from public.reservations r
  )
  select jsonb_build_object(
    'total',       count(*),
    'pending',     count(*) filter (where eff = 'pending'),
    'approved',    count(*) filter (where eff = 'approved'),
    'completed',   count(*) filter (where eff = 'completed'),
    'declined',    count(*) filter (where eff = 'declined'),
    'cancelled',   count(*) filter (where eff = 'cancelled'),
    'rescheduled', count(*) filter (where eff = 'rescheduled'),
    'upcoming',    count(*) filter (
                     where eff in ('pending', 'approved', 'rescheduled')
                       and event_date >= (now() at time zone 'Asia/Manila')::date
                   )
  )
  from s;
$$;

revoke all on function public.get_admin_reservation_counts() from public, anon;
grant execute on function public.get_admin_reservation_counts() to authenticated;


-- ----------------------------------------------------------------------------
-- One page of reservations.
--
--   p_status          all | upcoming | pending | approved | completed |
--                     declined | cancelled | rescheduled   (effective status;
--                     anything else behaves like 'all')
--   p_search          case-insensitive "contains" over customer name, customer
--                     email, reservation number and package name. LIKE
--                     wildcards typed by the user (% _ \) are escaped so they
--                     match literally, as the old JS .includes() did.
--   p_reservation_ids optional: only these reservations. Used by the "recent
--                     changes -> Review" banner, which narrows the list to
--                     the bookings it names.
--   p_limit/p_offset  the page window (limit is clamped to 1..100)
--
-- Order: 'upcoming' = soonest event first (date, then time, then oldest
-- booking first); every other view = newest booking first. reservation_id is
-- the final tie-breaker so pages never repeat or skip a row.
--
-- Each returned row also carries the payment summary fields the table shows
-- (computed_status, outstanding_balance), so the page does not need a second
-- request for them.
--
-- Returns { "total": <rows matching the filters>, "rows": [ ...one page... ] }
-- ----------------------------------------------------------------------------
create or replace function public.get_admin_reservations_page(
  p_status          text    default 'all',
  p_search          text    default null,
  p_reservation_ids uuid[]  default null,
  p_limit           integer default 25,
  p_offset          integer default 0
)
returns jsonb
language plpgsql
stable
security invoker
set search_path = public
as $$
declare
  v_status  text    := lower(coalesce(nullif(btrim(p_status), ''), 'all'));
  v_term    text    := nullif(btrim(left(coalesce(p_search, ''), 100)), '');
  v_pattern text;
  v_limit   integer := least(greatest(coalesce(p_limit, 25), 1), 100);
  v_offset  integer := greatest(coalesce(p_offset, 0), 0);
  v_today   date    := (now() at time zone 'Asia/Manila')::date;
begin
  if v_status not in ('all', 'upcoming', 'pending', 'approved', 'completed',
                      'declined', 'cancelled', 'rescheduled') then
    v_status := 'all';
  end if;

  -- Escape LIKE wildcards so the term is matched literally.
  if v_term is not null then
    v_pattern := '%'
      || replace(replace(replace(v_term, '\', '\\'), '%', '\%'), '_', '\_')
      || '%';
  end if;

  return (
    with filtered as (
      select r.reservation_id,
             r.reservation_number,
             r.contact_name,
             r.contact_email,
             r.status,
             r.event_date,
             r.event_time,
             r.total_price,
             r.created_at,
             pk.package_name,
             public.reservation_effective_status(
               r.status, r.event_date, r.event_time, r.reservation_id
             ) as effective_status
        from public.reservations r
        left join public.package pk on pk.package_id = r.package_id
       where (p_reservation_ids is null or r.reservation_id = any(p_reservation_ids))
         and (
           v_pattern is null
           or r.contact_name       ilike v_pattern
           or r.contact_email      ilike v_pattern
           or r.reservation_number ilike v_pattern
           or pk.package_name      ilike v_pattern
         )
    ),
    matched as (
      select f.*
        from filtered f
       where v_status = 'all'
          or (v_status = 'upcoming'
              and f.effective_status in ('pending', 'approved', 'rescheduled')
              and f.event_date >= v_today)
          or (v_status not in ('all', 'upcoming')
              and f.effective_status = v_status)
    ),
    ranked as (
      select m.*,
             row_number() over (
               order by
                 case when v_status = 'upcoming' then m.event_date end asc nulls last,
                 case when v_status = 'upcoming'
                      then public.parse_event_time_text(m.event_time) end asc nulls last,
                 case when v_status = 'upcoming' then m.created_at end asc,
                 case when v_status <> 'upcoming' then m.created_at end desc,
                 m.reservation_id desc
             ) as rn
        from matched m
    ),
    page as (
      select k.*
        from ranked k
       where k.rn > v_offset
         and k.rn <= v_offset + v_limit
    )
    select jsonb_build_object(
      'total', (select count(*) from matched),
      'rows',  coalesce(
        (
          select jsonb_agg(
                   jsonb_build_object(
                     'reservation_id',     pg.reservation_id,
                     'reservation_number', pg.reservation_number,
                     'contact_name',       pg.contact_name,
                     'contact_email',      pg.contact_email,
                     'status',             pg.status,
                     'effective_status',   pg.effective_status,
                     'event_date',         pg.event_date,
                     'event_time',         pg.event_time,
                     'total_price',        pg.total_price,
                     'created_at',         pg.created_at,
                     'package_name',       pg.package_name,
                     'computed_status',    ps.computed_status,
                     'outstanding_balance', ps.outstanding_balance
                   )
                   order by pg.rn
                 )
            from page pg
            left join lateral (
              select s.computed_status, s.outstanding_balance
                from public.reservation_payment_summary s
               where s.reservation_id = pg.reservation_id
            ) ps on true
        ),
        '[]'::jsonb
      )
    )
  );
end;
$$;

revoke all on function public.get_admin_reservations_page(text, text, uuid[], integer, integer) from public, anon;
grant execute on function public.get_admin_reservations_page(text, text, uuid[], integer, integer) to authenticated;

-- Make the API pick up the new functions immediately.
notify pgrst, 'reload schema';
