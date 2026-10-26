-- 20261031_admin_reviews_server_pagination.sql
--
-- Server-side pagination for the admin Reviews page (js/admin_reviews.js).
--
-- Before: the page downloaded EVERY customer profile, EVERY reservation (with
-- its package) and EVERY review, merged them in the browser, then searched and
-- paged there. Two of those three downloads existed only to show a name and an
-- event on each review row.
-- After: the browser asks for one page of reviews at a time (the page size is
-- set in js/admin_reviews.js, currently 15). The
-- database joins in the customer, reservation and package details for just
-- those rows and applies the search term itself. The four stat cards load
-- separately in one small call.
--
-- Both functions are SECURITY INVOKER, the same choice as
-- get_admin_nav_counts() and get_admin_customers_page(): they run with the
-- caller's own permissions, so row-level security applies exactly as it did for
-- the old direct queries. They grant no extra visibility.
--
-- Behaviour kept identical to the old browser code:
--   * newest review first (created_at DESC; review_id as a tie-breaker so pages
--     never repeat or skip a row)
--   * the customer is the review's profile ONLY when that profile has
--     role = 'customer' (the old fetch filtered on it); otherwise the row falls
--     back to the reservation's contact details
--   * search = case-insensitive "contains" over the same seven fields the old
--     JS checked: the displayed customer name (profile name parts, else the
--     reservation contact name, else the profile email, else the reservation
--     contact email, else 'Unknown customer'), the profile email, the
--     reservation contact email, the event type, the package name (or
--     'Package not available' when there is none), the comment, and the rating.
--     The term is matched literally (strpos), so %, _ and \ typed by the user
--     are ordinary characters, as the old JS .includes() treated them.
--   * stat cards count ALL reviews, never the current search.
--
-- Indexes already in place that these functions use:
--   reviews_created_at_idx        (created_at desc)
--   reservations / profiles / package primary keys (for the joins)

create or replace function public.get_admin_reviews_page(
  p_search text default null,
  p_limit  integer default 10,
  p_offset integer default 0
)
returns jsonb
language plpgsql
stable
security invoker
set search_path = public
as $$
declare
  v_needle text    := lower(nullif(btrim(left(coalesce(p_search, ''), 100)), ''));
  v_limit  integer := least(greatest(coalesce(p_limit, 10), 1), 100);
  v_offset integer := greatest(coalesce(p_offset, 0), 0);
  v_result jsonb;
begin
  with matched as (
    select r.review_id,
           r.reservation_id,
           r.user_id,
           r.rating,
           r.comment,
           r.created_at,
           p.first_name,
           p.middle_name,
           p.last_name,
           p.email          as customer_email,
           res.contact_name,
           res.contact_email,
           res.event_type,
           res.event_date,
           pk.package_name
      from public.reviews r
      left join public.profiles p
             on p.user_id = r.user_id and p.role = 'customer'
      left join public.reservations res
             on res.reservation_id = r.reservation_id
      left join public.package pk
             on pk.package_id = res.package_id
  ),
  filtered as (
    select m.*
      from matched m
     where v_needle is null
        or strpos(lower(coalesce(
             nullif(concat_ws(' ', nullif(m.first_name, ''), nullif(m.middle_name, ''), nullif(m.last_name, '')), ''),
             nullif(m.contact_name, ''),
             nullif(m.customer_email, ''),
             nullif(m.contact_email, ''),
             'Unknown customer')), v_needle) > 0
        or strpos(lower(coalesce(m.customer_email, '')), v_needle) > 0
        or strpos(lower(coalesce(m.contact_email, '')), v_needle) > 0
        or strpos(lower(coalesce(m.event_type, '')), v_needle) > 0
        or strpos(lower(coalesce(nullif(m.package_name, ''), 'Package not available')), v_needle) > 0
        or strpos(lower(coalesce(m.comment, '')), v_needle) > 0
        or strpos(coalesce(m.rating::text, ''), v_needle) > 0
  ),
  page as (
    select f.*
      from filtered f
     order by f.created_at desc, f.review_id desc
     limit v_limit offset v_offset
  )
  select jsonb_build_object(
           'total', (select count(*) from filtered),
           'rows',  coalesce(
                      (select jsonb_agg(
                                jsonb_build_object(
                                  'review_id',      pg.review_id,
                                  'reservation_id', pg.reservation_id,
                                  'user_id',        pg.user_id,
                                  'rating',         pg.rating,
                                  'comment',        pg.comment,
                                  'created_at',     pg.created_at,
                                  'first_name',     pg.first_name,
                                  'middle_name',    pg.middle_name,
                                  'last_name',      pg.last_name,
                                  'customer_email', pg.customer_email,
                                  'contact_name',   pg.contact_name,
                                  'contact_email',  pg.contact_email,
                                  'event_type',     pg.event_type,
                                  'event_date',     pg.event_date,
                                  'package_name',   pg.package_name
                                )
                                order by pg.created_at desc, pg.review_id desc
                              )
                         from page pg),
                      '[]'::jsonb)
         )
    into v_result;

  return v_result;
end;
$$;

revoke all on function public.get_admin_reviews_page(text, integer, integer) from public, anon;
grant execute on function public.get_admin_reviews_page(text, integer, integer) to authenticated;


-- The four stat cards on the Reviews page. They always describe ALL reviews
-- (never the current search), so they are loaded on their own and are not
-- re-fetched when the admin searches or changes page.
--
-- average_rating is returned unrounded; the browser formats it to one decimal
-- exactly as before.
create or replace function public.get_admin_review_stats()
returns jsonb
language sql
stable
security invoker
set search_path = public
as $$
  select jsonb_build_object(
    'total',          count(*),
    'average_rating', coalesce(avg(coalesce(r.rating, 0)), 0),
    'five_star',      count(*) filter (where coalesce(r.rating, 0) = 5),
    'commented',      count(*) filter (where coalesce(r.comment, '') ~ '\S')
  )
  from public.reviews r;
$$;

revoke all on function public.get_admin_review_stats() from public, anon;
grant execute on function public.get_admin_review_stats() to authenticated;
