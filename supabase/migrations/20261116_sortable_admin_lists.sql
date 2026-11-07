-- 20261116_sortable_admin_lists.sql
--
-- Column sorting for the admin list pages. Four of them (Reservations,
-- Payments, Contracts, Customers) load one page of rows at a time from the
-- database, so a sort can only be right across ALL rows if the database does
-- the ordering - sorting the 25 rows on screen would be misleading.
--
-- Each get_admin_*_page() function gets two optional trailing parameters:
--   p_sort_key  which column to sort by (see each function below; anything
--               else is treated as "no explicit sort")
--   p_sort_dir  'asc' (default) or 'desc'
--
-- Defaults when no sort key is given:
--   * Reservations - unchanged (newest booking first; soonest event first on
--                    the Upcoming chip).
--   * Payments, Contracts, Customers - alphabetical by customer name. The old
--     newest-first order is kept as the tie-breaker, so a customer's rows
--     still appear newest first.
--
-- Everything else about these functions (filters, search, security invoker,
-- the shape of the returned rows) is unchanged. Empty values always sort
-- last, in either direction. Because each function gains parameters, the old
-- signature is dropped first; leaving it would create an overload that
-- PostgREST cannot choose between.
-- Apply this BEFORE deploying the matching JavaScript. The pages retry
-- without the sort parameters if it is missing, but the order on screen
-- would then not match the sort shown in the header.

drop function if exists public.get_admin_reservations_page(text, text, uuid[], integer, integer);

create or replace function public.get_admin_reservations_page(
  p_status          text    default 'all',
  p_search          text    default null,
  p_reservation_ids uuid[]  default null,
  p_limit           integer default 25,
  p_offset          integer default 0,
  p_sort_key        text    default null,   -- customer | package | schedule
  p_sort_dir        text    default 'asc'   -- asc | desc
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
  v_sort_key text   := lower(nullif(btrim(p_sort_key), ''));
  v_desc     boolean := lower(coalesce(nullif(btrim(p_sort_dir), ''), 'asc')) = 'desc';
begin
  if v_sort_key not in ('customer', 'package', 'schedule') then
    v_sort_key := null;
  end if;

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
                 case when v_sort_key = 'customer' and not v_desc then lower(nullif(btrim(m.contact_name), '')) end asc  nulls last,
                 case when v_sort_key = 'customer' and v_desc     then lower(nullif(btrim(m.contact_name), '')) end desc nulls last,
                 case when v_sort_key = 'package' and not v_desc then lower(nullif(btrim(m.package_name), '')) end asc  nulls last,
                 case when v_sort_key = 'package' and v_desc     then lower(nullif(btrim(m.package_name), '')) end desc nulls last,
                 case when v_sort_key = 'schedule' and not v_desc then m.event_date end asc  nulls last,
                 case when v_sort_key = 'schedule' and v_desc     then m.event_date end desc nulls last,
                 case when v_sort_key = 'schedule' and not v_desc then public.parse_event_time_text(m.event_time) end asc  nulls last,
                 case when v_sort_key = 'schedule' and v_desc     then public.parse_event_time_text(m.event_time) end desc nulls last,
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

revoke all on function public.get_admin_reservations_page(text, text, uuid[], integer, integer, text, text) from public, anon;
grant execute on function public.get_admin_reservations_page(text, text, uuid[], integer, integer, text, text) to authenticated;

drop function if exists public.get_admin_customers_page(text, integer, integer);

create or replace function public.get_admin_customers_page(
  p_search text default null,
  p_limit  integer default 25,
  p_offset integer default 0,
  p_sort_key text  default null,   -- customer | registered (null = customer)
  p_sort_dir text  default 'asc'   -- asc | desc
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
  v_sort_key text   := lower(nullif(btrim(p_sort_key), ''));
  v_desc     boolean := lower(coalesce(nullif(btrim(p_sort_dir), ''), 'asc')) = 'desc';
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

  -- Total number of customers matching the search (for the page buttons).
  select count(*)
    into v_total
    from public.profiles p
   where p.role = 'customer'
     and (
       v_pattern is null
       or concat_ws(' ', nullif(p.first_name, ''), nullif(p.middle_name, ''), nullif(p.last_name, '')) ilike v_pattern
       or p.email ilike v_pattern
       or p.phone_number ilike v_pattern
     );

  -- The requested page, each row carrying its reservation activity.
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
               'last_reservation_date', a.last_reservation_date
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
           where p.role = 'customer'
             and (
               v_pattern is null
               or concat_ws(' ', nullif(p.first_name, ''), nullif(p.middle_name, ''), nullif(p.last_name, '')) ilike v_pattern
               or p.email ilike v_pattern
               or p.phone_number ilike v_pattern
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

revoke all on function public.get_admin_customers_page(text, integer, integer, text, text) from public, anon;
grant execute on function public.get_admin_customers_page(text, integer, integer, text, text) to authenticated;

drop function if exists public.get_admin_payments_page(text, text, text, integer, integer);

create or replace function public.get_admin_payments_page(
  p_status         text default 'all',
  p_search         text default null,
  p_reservation_id text default null,
  p_limit          integer default 20,
  p_offset         integer default 0,
  p_sort_key       text    default null,   -- reservation | customer | amount (null = customer)
  p_sort_dir       text    default 'asc'   -- asc | desc
)
returns jsonb
language plpgsql
stable
security invoker
set search_path = public
as $$
declare
  v_status text    := lower(coalesce(nullif(btrim(p_status), ''), 'all'));
  v_needle text    := lower(nullif(btrim(left(coalesce(p_search, ''), 100)), ''));
  v_res_id text    := nullif(btrim(p_reservation_id), '');
  v_limit  integer := least(greatest(coalesce(p_limit, 20), 1), 100);
  v_offset integer := greatest(coalesce(p_offset, 0), 0);
  v_result jsonb;
  v_sort_key text   := lower(nullif(btrim(p_sort_key), ''));
  v_desc     boolean := lower(coalesce(nullif(btrim(p_sort_dir), ''), 'asc')) = 'desc';
begin
  -- No (or an unknown) sort key means alphabetical by customer name.
  if v_sort_key is null or v_sort_key not in ('reservation', 'customer', 'amount') then
    v_sort_key := 'customer';
    v_desc := false;
  end if;

  with matched as (
    select p.*,
           res.reservation_number,
           res.contact_name,
           res.contact_email,
           res.event_time,
           res.event_date as res_event_date,
           pk.package_name
      from public.payment p
      left join public.reservations res on res.reservation_id = p.reservation_id
      left join public.package pk on pk.package_id = res.package_id
  ),
  filtered as (
    select m.*
      from matched m
     where (v_status = 'all' or lower(coalesce(m.payment_status, '')) = v_status)
       and (v_res_id is null or m.reservation_id::text = v_res_id)
       and (v_needle is null
            or strpos(lower(coalesce(m.reservation_number::text, '')), v_needle) > 0
            or strpos(lower(coalesce(m.contact_name, '')), v_needle) > 0
            or strpos(lower(coalesce(m.contact_email, '')), v_needle) > 0
            or strpos(lower(coalesce(m.package_name, '')), v_needle) > 0
            or strpos(lower(coalesce(m.event_time::text, '')), v_needle) > 0
            or strpos(lower(coalesce(m.payment_method::text, '')), v_needle) > 0
            or strpos(lower(coalesce(m.payment_method_label, '')), v_needle) > 0
            or strpos(lower(public.payment_method_display_label(m.payment_method::text)), v_needle) > 0
            or strpos(lower(public.payment_type_display_label(m.payment_type::text)), v_needle) > 0
            or strpos(lower(coalesce(m.reference_number, '')), v_needle) > 0)
  ),
  ranked as (
    select f.*,
           row_number() over (
             order by
             case when v_sort_key = 'customer' and not v_desc then lower(nullif(btrim(f.contact_name), '')) end asc  nulls last,
             case when v_sort_key = 'customer' and v_desc     then lower(nullif(btrim(f.contact_name), '')) end desc nulls last,
             case when v_sort_key = 'reservation' and not v_desc then lower(nullif(btrim(f.package_name), '')) end asc  nulls last,
             case when v_sort_key = 'reservation' and v_desc     then lower(nullif(btrim(f.package_name), '')) end desc nulls last,
             case when v_sort_key = 'reservation' and not v_desc then f.res_event_date end asc  nulls last,
             case when v_sort_key = 'reservation' and v_desc     then f.res_event_date end desc nulls last,
             case when v_sort_key = 'reservation' and not v_desc then public.parse_event_time_text(f.event_time::text) end asc  nulls last,
             case when v_sort_key = 'reservation' and v_desc     then public.parse_event_time_text(f.event_time::text) end desc nulls last,
             case when v_sort_key = 'amount' and not v_desc then f.amount end asc  nulls last,
             case when v_sort_key = 'amount' and v_desc     then f.amount end desc nulls last,
             f.submitted_at desc,
             f.payment_id desc
           ) as rn
      from filtered f
  ),
  page as (
    select k.*
      from ranked k
     where k.rn > v_offset
       and k.rn <= v_offset + v_limit
  )
  select jsonb_build_object(
           'total', (select count(*) from filtered),
           'rows',  coalesce(
                      (select jsonb_agg(
                                jsonb_build_object(
                                  'payment_id',                 pg.payment_id,
                                  'reservation_id',             pg.reservation_id,
                                  'reschedule_request_id',      pg.reschedule_request_id,
                                  'extension_id',               pg.extension_id,
                                  'additional_head_request_id', pg.additional_head_request_id,
                                  'payment_type',               pg.payment_type,
                                  'payment_method',             pg.payment_method,
                                  'payment_method_id',          pg.payment_method_id,
                                  'payment_method_label',       pg.payment_method_label,
                                  'payment_source',             pg.payment_source,
                                  'amount',                     pg.amount,
                                  'payment_status',             pg.payment_status,
                                  'reference_number',           pg.reference_number,
                                  'payment_date',               pg.payment_date,
                                  'notes',                      pg.notes,
                                  'proof_url',                  pg.proof_url,
                                  'cash_payment_date',          pg.cash_payment_date,
                                  'actual_payment_date',        pg.actual_payment_date,
                                  'submitted_at',               pg.submitted_at,
                                  'verified_at',                pg.verified_at,
                                  'ocr_extracted',              pg.ocr_extracted
                                )
                                order by pg.rn
                              )
                         from page pg),
                      '[]'::jsonb)
         )
    into v_result;

  return v_result;
end;
$$;

revoke all on function public.get_admin_payments_page(text, text, text, integer, integer, text, text) from public, anon;
grant execute on function public.get_admin_payments_page(text, text, text, integer, integer, text, text) to authenticated;

drop function if exists public.get_admin_contracts_page(text, text, uuid, integer, integer);

create or replace function public.get_admin_contracts_page(
  p_status         text    default 'all',
  p_search         text    default null,
  p_reservation_id uuid    default null,
  p_limit          integer default 10,
  p_offset         integer default 0,
  p_sort_key       text    default null,   -- customer | package | schedule (null = customer)
  p_sort_dir       text    default 'asc'   -- asc | desc
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
  v_sort_key text   := lower(nullif(btrim(p_sort_key), ''));
  v_desc     boolean := lower(coalesce(nullif(btrim(p_sort_dir), ''), 'asc')) = 'desc';
begin
  -- No (or an unknown) sort key means alphabetical by customer name.
  if v_sort_key is null or v_sort_key not in ('customer', 'package', 'schedule') then
    v_sort_key := 'customer';
    v_desc := false;
  end if;

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
    ranked as (
      select m.*,
             row_number() over (
               order by
               case when v_sort_key = 'customer' and not v_desc then lower(nullif(btrim(m.contact_name), '')) end asc  nulls last,
               case when v_sort_key = 'customer' and v_desc     then lower(nullif(btrim(m.contact_name), '')) end desc nulls last,
               case when v_sort_key = 'package' and not v_desc then lower(nullif(btrim(m.package_name), '')) end asc  nulls last,
               case when v_sort_key = 'package' and v_desc     then lower(nullif(btrim(m.package_name), '')) end desc nulls last,
               case when v_sort_key = 'schedule' and not v_desc then m.event_date end asc  nulls last,
               case when v_sort_key = 'schedule' and v_desc     then m.event_date end desc nulls last,
               case when v_sort_key = 'schedule' and not v_desc then public.parse_event_time_text(m.event_time) end asc  nulls last,
               case when v_sort_key = 'schedule' and v_desc     then public.parse_event_time_text(m.event_time) end desc nulls last,
               m.activity_at desc,
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
                   order by pg.rn
                 )
            from page pg
        ),
        '[]'::jsonb
      )
    )
  );
end;
$$;

revoke all on function public.get_admin_contracts_page(text, text, uuid, integer, integer, text, text) from public, anon;
grant execute on function public.get_admin_contracts_page(text, text, uuid, integer, integer, text, text) to authenticated;

-- Make the API pick up the new signatures immediately.
notify pgrst, 'reload schema';
