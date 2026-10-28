-- 20261105_anonymous_reviews.sql
--
-- Anonymous reviews. A customer can now choose to post a review anonymously
-- when they submit it, and can switch that on or off later from the public
-- Reviews page (Edit button on their own review cards).
--
-- What "anonymous" means here
--   * Other guests (and logged-out visitors) never receive the reviewer's
--     name. The name is removed INSIDE the database (get_public_reviews below),
--     so it is not just hidden by the page's JavaScript - a visitor cannot
--     read it out of the network response.
--   * The ELI Coffee team (admin / manager) can still see who wrote the review
--     in the admin Reviews page, marked "Anonymous publicly". The review is
--     still tied to a real, completed reservation.
--   * The review still counts toward the average rating and star breakdown.
--
-- Apply manually in the Supabase SQL Editor (see CLAUDE.md > Database
-- Migrations). Safe to re-run.
--
-- IMPORTANT - verify after applying: js/reviews.js now reads the public list
-- through get_public_reviews() instead of querying reviews + profiles
-- directly. If the live project ALSO has a broad "anyone can read" SELECT
-- policy on public.reviews or on the name columns of public.profiles (neither
-- is in this repo's migrations, but the public page worked before, so
-- something equivalent exists), a determined visitor could still join
-- reviews.user_id to profiles themselves. Check with:
--   select tablename, policyname, cmd, qual from pg_policies
--   where tablename in ('reviews', 'profiles');
-- and tighten any policy that lets non-owners read other customers' review
-- rows or names directly, so this function is the only public route.


-- 1. The flag -----------------------------------------------------------------
alter table public.reviews
  add column if not exists is_anonymous boolean not null default false;


-- 2. Public reviews list ------------------------------------------------------
-- What the public Reviews page loads. SECURITY DEFINER so it can read the name
-- and package for every review regardless of the caller's own RLS, and then
-- decide per row what is safe to reveal:
--   * anonymous review      -> first_name / last_name come back NULL, and
--                              user_id is never returned at all
--   * the caller's own row  -> is_mine = true (so the page can show Edit)
-- Callable by logged-out visitors (the page is public); auth.uid() is NULL for
-- them, so is_mine is always false.
create or replace function public.get_public_reviews()
returns table (
  review_id      uuid,
  reservation_id uuid,
  rating         integer,
  comment        text,
  created_at     timestamptz,
  is_anonymous   boolean,
  is_mine        boolean,
  first_name     text,
  last_name      text,
  package_name   text
)
language sql
stable
security definer
set search_path = public
as $$
  select r.review_id,
         r.reservation_id,
         r.rating,
         r.comment::text,
         r.created_at,
         r.is_anonymous,
         (auth.uid() is not null and r.user_id = auth.uid()) as is_mine,
         case when r.is_anonymous then null else p.first_name::text end as first_name,
         case when r.is_anonymous then null else p.last_name::text  end as last_name,
         pk.package_name::text
    from public.reviews r
    left join public.profiles     p   on p.user_id = r.user_id
    left join public.reservations res on res.reservation_id = r.reservation_id
    left join public.package      pk  on pk.package_id = res.package_id
   order by r.created_at desc, r.review_id desc;
$$;

revoke all on function public.get_public_reviews() from public;
grant execute on function public.get_public_reviews() to anon, authenticated;


-- 3. Let a customer flip anonymity on their own review ------------------------
-- A dedicated function instead of a general UPDATE policy on public.reviews:
-- this is the ONLY thing a customer may change after submitting (the rating
-- and comment stay as written), and it can only touch their own row.
create or replace function public.set_review_anonymity(
  p_review_id    uuid,
  p_is_anonymous boolean
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_value   boolean := coalesce(p_is_anonymous, false);
  v_updated integer;
begin
  if auth.uid() is null then
    raise exception 'You must be signed in to edit a review.';
  end if;

  update public.reviews
     set is_anonymous = v_value
   where review_id = p_review_id
     and user_id = auth.uid();

  get diagnostics v_updated = row_count;

  if v_updated = 0 then
    raise exception 'Review not found or not owned by current user.';
  end if;

  return v_value;
end;
$$;

revoke all on function public.set_review_anonymity(uuid, boolean) from public, anon;
grant execute on function public.set_review_anonymity(uuid, boolean) to authenticated;


-- 4. Admin Reviews page: also return the flag ---------------------------------
-- Same function as 20261031_admin_reviews_server_pagination.sql with one extra
-- field ('is_anonymous') so the admin table can mark reviews that are shown
-- anonymously to the public. Admins still receive the real customer name.
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
           r.is_anonymous,
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
                                  'is_anonymous',   pg.is_anonymous,
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
