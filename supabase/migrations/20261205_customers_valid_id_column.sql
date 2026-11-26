-- Customers page: Valid ID column, "Flagged IDs" filter and count.
--
-- Why
--   A manager could only see a customer's ID from inside one reservation's
--   contract panel, so a flagged customer with no reservation yet could never
--   be reviewed, and there was no list of IDs waiting for a decision. The
--   Customers page now shows every customer's ID status and lets managers
--   review flagged IDs there (review-customer-id with customer_id).
--
-- What this changes
--   * get_admin_customers_page() rows gain:
--       valid_id_status       none | unchecked | clear | flagged | approved | rejected
--       valid_id_review_note  the manager's note (shown for rejected IDs)
--     and the function takes p_id_filter ('all' | 'flagged'). It is dropped and
--     re-created because the argument list changes; p_id_filter defaults to
--     'all', so the page keeps working exactly as before when it is not sent.
--   * get_admin_customer_stats() gains flagged_ids: how many customers have an
--     ID waiting for a manager.
--
-- The status comes from the same place every other ID check reads:
--   no photo on file (valid_id_uploaded_at and valid_id_back_uploaded_at both
--   NULL)                     -> 'none'
--   otherwise                 -> valid_id_review.status, or 'unchecked' when
--                                there is no row yet (uploaded before the
--                                review table existed)
-- Both functions stay SECURITY INVOKER: they read with the caller's own
-- permissions (staff can read profiles and, through the "valid id review: staff
-- can read" policy, valid_id_review). Nothing here exposes the photos.
--
-- Needs 20261201_valid_id_front_back_manager_review.sql and
-- 20261202_valid_id_signature_flag_and_review.sql.
-- ─────────────────────────────────────────────────────────────────────────────

drop function if exists public.get_admin_customers_page(text, integer, integer, text, text);

create or replace function public.get_admin_customers_page(
  p_search    text    default null,
  p_limit     integer default 25,
  p_offset    integer default 0,
  p_sort_key  text    default null,   -- customer | registered (null = customer)
  p_sort_dir  text    default 'asc',  -- asc | desc
  p_id_filter text    default 'all'   -- all | flagged
)
returns jsonb
language plpgsql
stable
security invoker
set search_path = public
as $$
declare
  v_term    text    := nullif(btrim(left(coalesce(p_search, ''), 100)), '');
  v_pattern text;
  v_limit   integer := least(greatest(coalesce(p_limit, 25), 1), 100);
  v_offset  integer := greatest(coalesce(p_offset, 0), 0);
  v_total   bigint;
  v_rows    jsonb;
  v_sort_key text    := lower(nullif(btrim(p_sort_key), ''));
  v_desc     boolean := lower(coalesce(nullif(btrim(p_sort_dir), ''), 'asc')) = 'desc';
  v_flagged  boolean := lower(coalesce(nullif(btrim(p_id_filter), ''), 'all')) = 'flagged';
begin
  -- No (or an unknown) sort key means alphabetical by customer name.
  if v_sort_key is null or v_sort_key not in ('customer', 'registered') then
    v_sort_key := 'customer';
    v_desc := false;
  end if;

  -- Escape LIKE wildcards so the term is matched literally.
  if v_term is not null then
    v_pattern := '%'
      || replace(replace(replace(v_term, '\', '\\'), '%', '\%'), '_', '\_')
      || '%';
  end if;

  -- Total number of customers matching the search and ID filter.
  select count(*)
    into v_total
    from public.profiles p
    left join public.valid_id_review v on v.user_id = p.user_id
   where p.role = 'customer'
     and (
       v_pattern is null
       or concat_ws(' ', nullif(p.first_name, ''), nullif(p.middle_name, ''), nullif(p.last_name, '')) ilike v_pattern
       or p.email ilike v_pattern
       or p.phone_number ilike v_pattern
     )
     and (
       not v_flagged
       or (
         (p.valid_id_uploaded_at is not null or p.valid_id_back_uploaded_at is not null)
         and v.status = 'flagged'
       )
     );

  -- The requested page, each row carrying its reservation activity and ID status.
  -- NOTE: the WHERE clause below must stay identical to the one above.
  select coalesce(
           jsonb_agg(
             jsonb_build_object(
               'user_id',               pg.user_id,
               'first_name',            pg.first_name,
               'middle_name',           pg.middle_name,
               'last_name',             pg.last_name,
               'email',                 pg.email,
               'phone_number',          pg.phone_number,
               'date_registered',       pg.date_registered,
               'role',                  pg.role,
               'total_reservations',    coalesce(a.total_reservations, 0),
               'approved_reservations', coalesce(a.approved_reservations, 0),
               'last_reservation_date', a.last_reservation_date,
               'valid_id_status',       pg.valid_id_status,
               'valid_id_review_note',  pg.valid_id_review_note
             )
             order by pg.rn
           ),
           '[]'::jsonb
         )
    into v_rows
    from (
      select k.*
        from (
          select p.user_id, p.first_name, p.middle_name, p.last_name,
                 p.email, p.phone_number, p.date_registered, p.role,
                 case
                   when p.valid_id_uploaded_at is null and p.valid_id_back_uploaded_at is null then 'none'
                   else coalesce(v.status, 'unchecked')
                 end as valid_id_status,
                 v.review_note as valid_id_review_note,
                 row_number() over (
                   order by
                     case when v_sort_key = 'customer' and not v_desc then lower(nullif(concat_ws(' ', nullif(p.first_name, ''), nullif(p.middle_name, ''), nullif(p.last_name, '')), '')) end asc  nulls last,
                     case when v_sort_key = 'customer' and v_desc     then lower(nullif(concat_ws(' ', nullif(p.first_name, ''), nullif(p.middle_name, ''), nullif(p.last_name, '')), '')) end desc nulls last,
                     case when v_sort_key = 'registered' and not v_desc then p.date_registered end asc  nulls last,
                     case when v_sort_key = 'registered' and v_desc     then p.date_registered end desc nulls last,
                     p.date_registered desc,
                     p.user_id
                 ) as rn
            from public.profiles p
            left join public.valid_id_review v on v.user_id = p.user_id
           where p.role = 'customer'
             and (
               v_pattern is null
               or concat_ws(' ', nullif(p.first_name, ''), nullif(p.middle_name, ''), nullif(p.last_name, '')) ilike v_pattern
               or p.email ilike v_pattern
               or p.phone_number ilike v_pattern
             )
             and (
               not v_flagged
               or (
                 (p.valid_id_uploaded_at is not null or p.valid_id_back_uploaded_at is not null)
                 and v.status = 'flagged'
               )
             )
        ) k
       where k.rn > v_offset
         and k.rn <= v_offset + v_limit
    ) pg
    left join lateral (
      select count(*)::integer as total_reservations,
             (count(*) filter (where lower(r.status) in ('approved', 'confirmed')))::integer as approved_reservations,
             max(r.created_at) as last_reservation_date
        from public.reservations r
       where r.user_id = pg.user_id
    ) a on true;

  return jsonb_build_object('total', v_total, 'rows', v_rows);
end;
$$;

revoke all on function public.get_admin_customers_page(text, integer, integer, text, text, text) from public, anon;
grant execute on function public.get_admin_customers_page(text, integer, integer, text, text, text) to authenticated;

-- Stat cards: same four counts as before, plus flagged_ids.
create or replace function public.get_admin_customer_stats(
  p_month_start timestamptz,
  p_month_end   timestamptz
)
returns jsonb
language sql
stable
security invoker
set search_path = public
as $$
  select jsonb_build_object(
    'total',
      (select count(*)
         from public.profiles p
        where p.role = 'customer'),
    'with_reservations',
      (select count(*)
         from public.profiles p
        where p.role = 'customer'
          and exists (select 1 from public.reservations r where r.user_id = p.user_id)),
    'new_this_month',
      (select count(*)
         from public.profiles p
        where p.role = 'customer'
          and p.date_registered >= p_month_start
          and p.date_registered <  p_month_end),
    'with_phone',
      (select count(*)
         from public.profiles p
        where p.role = 'customer'
          and coalesce(p.phone_number, '') <> ''),
    'flagged_ids',
      (select count(*)
         from public.profiles p
         join public.valid_id_review v on v.user_id = p.user_id
        where p.role = 'customer'
          and (p.valid_id_uploaded_at is not null or p.valid_id_back_uploaded_at is not null)
          and v.status = 'flagged')
  );
$$;

revoke all on function public.get_admin_customer_stats(timestamptz, timestamptz) from public, anon;
grant execute on function public.get_admin_customer_stats(timestamptz, timestamptz) to authenticated;

notify pgrst, 'reload schema';
