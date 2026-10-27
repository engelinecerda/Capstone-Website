-- 20261103_admin_contracts_server_pagination.sql
--
-- Server-side pagination, filtering and search for the admin Contracts page
-- (js/admin_contracts.js).
--
-- Before: every page load and every 60-second auto-refresh downloaded ALL
-- reservations (with their package), then ALL of their contracts, and the
-- page then kept only the reservations that have an uploaded contract file,
-- sorted, searched, filtered, counted and paged them in the browser.
--
-- After: the browser asks for one page of contracts, already filtered and
-- searched in the database, and loads the stat-card / chip counts in one
-- small separate call. A single contract can also be fetched by reservation id
-- (used for the "?reservation=<id>" deep link and for keeping the review
-- window open after an action, when the contract is no longer on the page on
-- screen).
--
-- Both functions are SECURITY INVOKER (same choice as get_admin_nav_counts(),
-- get_admin_customers_page() and get_admin_reservations_page()): they run with
-- the caller's own permissions, so row-level security applies exactly as it did
-- for the old direct queries. They grant no extra visibility.
--
-- Behaviour kept identical to the old browser code:
--   * the list is the reservations that have a contract file
--     (contract_url is not empty); a reservation without one never appeared
--   * "Verified" = review_status is 'verified' OR verified_date is set;
--     every other contract with a file is "Pending review"
--   * newest activity first: reviewed_at, else verified_date, else the
--     reservation's created_at (reservation_id as the final tie-breaker so
--     pages never repeat or skip a row)
--   * search = case-insensitive "contains" over customer name, customer email,
--     package name, event type, venue location, reservation number, the
--     contract's review note (only shown, and so only searched, while the
--     contract is pending) and the status label ("Verified contract" /
--     "Pending review"). LIKE wildcards typed by the user (% _ \) are escaped
--     so they match literally, as the old JS .includes() did.
--   * stat cards and chips count ALL contracts with a file, never the current
--     search or page.
--
-- Indexes already in place that these functions use:
--   reservation_contracts_reservation_id_key (unique, reservation_id)
--   reservations / package primary keys (for the joins)


-- ----------------------------------------------------------------------------
-- Counts for the stat cards and the status chips.
-- ----------------------------------------------------------------------------
create or replace function public.get_admin_contract_counts()
returns jsonb
language sql
stable
security invoker
set search_path = public
as $$
  select jsonb_build_object(
    'total',    count(*),
    'approved', count(*) filter (
                  where lower(coalesce(c.review_status, '')) = 'verified'
                     or c.verified_date is not null
                ),
    'pending',  count(*) filter (
                  where not (
                    lower(coalesce(c.review_status, '')) = 'verified'
                    or c.verified_date is not null
                  )
                )
  )
  from public.reservation_contracts c
  join public.reservations r on r.reservation_id = c.reservation_id
  where coalesce(c.contract_url, '') <> '';
$$;

revoke all on function public.get_admin_contract_counts() from public, anon;
grant execute on function public.get_admin_contract_counts() to authenticated;


-- ----------------------------------------------------------------------------
-- One page of contracts.
--
--   p_status          all | pending | approved   (anything else = all)
--   p_search          see above
--   p_reservation_id  optional: only this reservation's contract. Used to open
--                     one contract that is not on the page on screen.
--   p_limit/p_offset  the page window (limit is clamped to 1..100)
--
-- Returns { "total": <rows matching the filters>, "rows": [ ...one page... ] }
-- Each row carries the reservation fields the table and the review window
-- show, plus the contract record, so no second request is needed.
-- ----------------------------------------------------------------------------
create or replace function public.get_admin_contracts_page(
  p_status         text    default 'all',
  p_search         text    default null,
  p_reservation_id uuid    default null,
  p_limit          integer default 10,
  p_offset         integer default 0
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
  v_limit   integer := least(greatest(coalesce(p_limit, 10), 1), 100);
  v_offset  integer := greatest(coalesce(p_offset, 0), 0);
begin
  if v_status not in ('all', 'pending', 'approved') then
    v_status := 'all';
  end if;

  -- Escape LIKE wildcards so the term is matched literally.
  if v_term is not null then
    v_pattern := '%'
      || replace(replace(replace(v_term, '\', '\\'), '%', '\%'), '_', '\_')
      || '%';
  end if;

  return (
    with base as (
      select r.reservation_id,
             r.reservation_number,
             r.contact_name,
             r.contact_email,
             r.contact_phone,
             r.status,
             r.event_type,
             r.event_date,
             r.event_time,
             r.guest_count,
             r.location_type,
             r.venue_location,
             r.total_price,
             r.created_at,
             pk.package_name,
             c.contract_url,
             c.verified_date,
             c.template_id,
             c.review_status,
             c.review_notes,
             c.reviewed_at,
             (lower(coalesce(c.review_status, '')) = 'verified'
              or c.verified_date is not null)               as is_verified,
             coalesce(c.reviewed_at, c.verified_date, r.created_at) as activity_at
        from public.reservation_contracts c
        join public.reservations r on r.reservation_id = c.reservation_id
        left join public.package pk on pk.package_id = r.package_id
       where coalesce(c.contract_url, '') <> ''
         and (p_reservation_id is null or r.reservation_id = p_reservation_id)
    ),
    matched as (
      select b.*
        from base b
       where (v_status = 'all'
              or (v_status = 'approved' and b.is_verified)
              or (v_status = 'pending'  and not b.is_verified))
         and (
           v_pattern is null
           or b.contact_name       ilike v_pattern
           or b.contact_email      ilike v_pattern
           or b.package_name       ilike v_pattern
           or b.event_type         ilike v_pattern
           or b.venue_location     ilike v_pattern
           or b.reservation_number ilike v_pattern
           or (not b.is_verified and b.review_notes ilike v_pattern)
           or (case when b.is_verified then 'Verified contract'
                    else 'Pending review' end) ilike v_pattern
         )
    ),
    page as (
      select m.*
        from matched m
       order by m.activity_at desc, m.reservation_id desc
      offset v_offset
       limit v_limit
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
                     'contact_phone',      pg.contact_phone,
                     'status',             pg.status,
                     'event_type',         pg.event_type,
                     'event_date',         pg.event_date,
                     'event_time',         pg.event_time,
                     'guest_count',        pg.guest_count,
                     'location_type',      pg.location_type,
                     'venue_location',     pg.venue_location,
                     'total_price',        pg.total_price,
                     'created_at',         pg.created_at,
                     'package_name',       pg.package_name,
                     'contract',           jsonb_build_object(
                                             'reservation_id', pg.reservation_id,
                                             'contract_url',   pg.contract_url,
                                             'verified_date',  pg.verified_date,
                                             'template_id',    pg.template_id,
                                             'review_status',  pg.review_status,
                                             'review_notes',   pg.review_notes,
                                             'reviewed_at',    pg.reviewed_at
                                           )
                   )
                   order by pg.activity_at desc, pg.reservation_id desc
                 )
            from page pg
        ),
        '[]'::jsonb
      )
    )
  );
end;
$$;

revoke all on function public.get_admin_contracts_page(text, text, uuid, integer, integer) from public, anon;
grant execute on function public.get_admin_contracts_page(text, text, uuid, integer, integer) to authenticated;

-- Make the API pick up the new functions immediately.
notify pgrst, 'reload schema';
