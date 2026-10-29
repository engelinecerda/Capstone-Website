-- Review moderation. Hidden reviews remain visible to their author and staff,
-- but are omitted from public results and all public rating aggregates.
alter table public.reviews
  add column if not exists is_hidden boolean not null default false,
  add column if not exists moderation_reason text,
  add column if not exists moderated_by uuid references auth.users(id) on delete set null,
  add column if not exists moderated_at timestamptz;

create or replace function public.get_public_reviews()
returns table (
  review_id uuid, reservation_id uuid, rating integer, comment text,
  created_at timestamptz, is_anonymous boolean, is_mine boolean,
  first_name text, last_name text, package_name text
)
language sql stable security definer set search_path = public
as $$
  select r.review_id, r.reservation_id, r.rating, r.comment::text, r.created_at,
         r.is_anonymous, (auth.uid() is not null and r.user_id = auth.uid()),
         case when r.is_anonymous then null else p.first_name::text end,
         case when r.is_anonymous then null else p.last_name::text end,
         pk.package_name::text
    from public.reviews r
    left join public.profiles p on p.user_id = r.user_id
    left join public.reservations res on res.reservation_id = r.reservation_id
    left join public.package pk on pk.package_id = res.package_id
   where not r.is_hidden
   order by r.created_at desc, r.review_id desc;
$$;
revoke all on function public.get_public_reviews() from public;
grant execute on function public.get_public_reviews() to anon, authenticated;

create or replace function public.get_public_reviews_with_moderation()
returns table (
  review_id uuid,
  reservation_id uuid,
  rating integer,
  comment text,
  created_at timestamptz,
  is_anonymous boolean,
  is_mine boolean,
  first_name text,
  last_name text,
  package_name text,
  is_hidden boolean
)
language sql stable security definer set search_path = public
as $$
  select r.review_id, r.reservation_id, r.rating, r.comment::text, r.created_at,
         r.is_anonymous,
         (auth.uid() is not null and r.user_id = auth.uid()),
         case when r.is_anonymous then null else p.first_name::text end,
         case when r.is_anonymous then null else p.last_name::text end,
         pk.package_name::text,
         r.is_hidden
    from public.reviews r
    left join public.profiles p on p.user_id = r.user_id
    left join public.reservations res on res.reservation_id = r.reservation_id
    left join public.package pk on pk.package_id = res.package_id
   where not r.is_hidden or r.user_id = auth.uid()
   order by r.created_at desc, r.review_id desc;
$$;
revoke all on function public.get_public_reviews_with_moderation() from public;
grant execute on function public.get_public_reviews_with_moderation() to anon, authenticated;

create or replace function public.get_admin_reviews_page(
  p_search text default null, p_limit integer default 10, p_offset integer default 0
)
returns jsonb language plpgsql stable security invoker set search_path = public
as $$
declare
  v_needle text := lower(nullif(btrim(left(coalesce(p_search, ''), 100)), ''));
  v_limit integer := least(greatest(coalesce(p_limit, 10), 1), 100);
  v_offset integer := greatest(coalesce(p_offset, 0), 0);
  v_result jsonb;
begin
  with matched as (
    select r.review_id, r.reservation_id, r.user_id, r.rating, r.comment,
           r.created_at, r.is_anonymous, r.is_hidden, r.moderation_reason,
           r.moderated_at, p.first_name, p.middle_name, p.last_name,
           p.email as customer_email, res.contact_name, res.contact_email,
           res.event_type, res.event_date, pk.package_name
      from public.reviews r
      left join public.profiles p on p.user_id = r.user_id and p.role = 'customer'
      left join public.reservations res on res.reservation_id = r.reservation_id
      left join public.package pk on pk.package_id = res.package_id
  ), filtered as (
    select m.* from matched m
     where v_needle is null
        or strpos(lower(coalesce(concat_ws(' ', m.first_name, m.middle_name, m.last_name), m.contact_name, m.customer_email, m.contact_email, m.event_type, m.package_name, m.comment, m.rating::text, '')), v_needle) > 0
  ), page as (
    select f.* from filtered f order by f.created_at desc, f.review_id desc limit v_limit offset v_offset
  )
  select jsonb_build_object(
    'total', (select count(*) from filtered),
    'rows', coalesce((select jsonb_agg(jsonb_build_object(
      'review_id', pg.review_id, 'reservation_id', pg.reservation_id,
      'user_id', pg.user_id, 'rating', pg.rating, 'comment', pg.comment,
      'created_at', pg.created_at, 'is_anonymous', pg.is_anonymous,
      'is_hidden', pg.is_hidden, 'moderation_reason', pg.moderation_reason,
      'moderated_at', pg.moderated_at, 'first_name', pg.first_name,
      'middle_name', pg.middle_name, 'last_name', pg.last_name,
      'customer_email', pg.customer_email, 'contact_name', pg.contact_name,
      'contact_email', pg.contact_email, 'event_type', pg.event_type,
      'event_date', pg.event_date, 'package_name', pg.package_name
    ) order by pg.created_at desc, pg.review_id desc) from page pg), '[]'::jsonb)
  ) into v_result;
  return v_result;
end;
$$;
revoke all on function public.get_admin_reviews_page(text, integer, integer) from public, anon;
grant execute on function public.get_admin_reviews_page(text, integer, integer) to authenticated;

create or replace function public.get_admin_review_stats()
returns jsonb language sql stable security invoker set search_path = public
as $$
  select jsonb_build_object(
    'total', count(*),
    'average_rating', coalesce(avg(coalesce(r.rating, 0)), 0),
    'five_star', count(*) filter (where coalesce(r.rating, 0) = 5),
    'commented', count(*) filter (where coalesce(r.comment, '') ~ '\S')
  ) from public.reviews r;
$$;
revoke all on function public.get_admin_review_stats() from public, anon;
grant execute on function public.get_admin_review_stats() to authenticated;

create or replace function public.moderate_review(p_review_id uuid, p_hidden boolean, p_reason text)
returns boolean language plpgsql security definer set search_path = public
as $$
declare
  v_actor public.profiles%rowtype;
  v_review public.reviews%rowtype;
  v_reason text := nullif(btrim(left(coalesce(p_reason, ''), 500)), '');
begin
  select * into v_actor from public.profiles where user_id = auth.uid() and role in ('manager', 'admin');
  if v_actor.user_id is null then raise exception 'Only managers can moderate reviews.'; end if;
  if v_reason is null then raise exception 'A moderation reason is required.'; end if;
  update public.reviews
     set is_hidden = coalesce(p_hidden, false),
         moderation_reason = v_reason,
         moderated_by = auth.uid(), moderated_at = now()
   where review_id = p_review_id returning * into v_review;
  if v_review.review_id is null then raise exception 'Review not found.'; end if;
  insert into public.audit_log(user_id, user_name, user_role, action, category, details, entity_id)
  values (auth.uid(), trim(concat_ws(' ', v_actor.first_name, v_actor.last_name)), v_actor.role,
          case when v_review.is_hidden then 'Hid Review' else 'Unhid Review' end,
          'review', v_reason, v_review.review_id::text);
  return v_review.is_hidden;
end;
$$;
revoke all on function public.moderate_review(uuid, boolean, text) from public, anon;
grant execute on function public.moderate_review(uuid, boolean, text) to authenticated;

notify pgrst, 'reload schema';
