-- 20261030_admin_customers_server_pagination.sql
--
-- Server-side pagination for the admin Customers page (js/admin_customers.js).
--
-- Before: the page downloaded EVERY customer profile plus an aggregate row for
-- every customer with a reservation, then searched and paged in the browser.
-- After: the browser asks for one page (25 rows) at a time, with the search
-- term applied in the database, and loads the four stat-card numbers
-- separately in one small call.
--
-- Both functions are SECURITY INVOKER, the same choice as
-- get_admin_nav_counts(): they run with the caller's own permissions, so row
-- level security applies exactly as it did for the old direct queries
-- ("admin read all profiles" / "admin read all reservations" let the
-- manager and admin roles see everything; a customer calling these would only
-- ever get their own profile row). They grant no extra visibility.
--
-- Behaviour kept identical to the old browser code:
--   * only profiles with role = 'customer'
--   * ordered newest registration first (date_registered DESC, which puts
--     NULLs first - the same as the old .order('date_registered',
--     { ascending: false })), with user_id as a tie-breaker so pages never
--     repeat or skip a row
--   * search = case-insensitive "contains" over the full display name
--     (first + middle + last, joined by single spaces, empty parts skipped),
--     the email, and the phone number. LIKE wildcards typed by the user
--     (% _ \) are escaped so they match literally, as the old JS .includes()
--     did.
--   * per-customer activity = total reservations, approved/confirmed count,
--     and the latest reservation created_at (same numbers as
--     get_customer_reservation_activity(), but only for the 25 rows shown).
--
-- get_customer_reservation_activity() is left in place, untouched; this page
-- no longer calls it.
--
-- Indexes already in place that these functions use:
--   profiles_role_date_registered_idx  (role, date_registered)
--   reservations_user_id_idx           (user_id)

create or replace function public.get_admin_customers_page(
  p_search text default null,
  p_limit  integer default 25,
  p_offset integer default 0
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
begin
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
             order by pg.date_registered desc, pg.user_id
           ),
           '[]'::jsonb
         )
    into v_rows
    from (
      select p.user_id, p.first_name, p.middle_name, p.last_name,
             p.email, p.phone_number, p.date_registered, p.role
        from public.profiles p
       where p.role = 'customer'
         and (
           v_pattern is null
           or concat_ws(' ', nullif(p.first_name, ''), nullif(p.middle_name, ''), nullif(p.last_name, '')) ilike v_pattern
           or p.email ilike v_pattern
           or p.phone_number ilike v_pattern
         )
       order by p.date_registered desc, p.user_id
       limit v_limit offset v_offset
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

revoke all on function public.get_admin_customers_page(text, integer, integer) from public, anon;
grant execute on function public.get_admin_customers_page(text, integer, integer) to authenticated;


-- The four stat cards on the Customers page. They always describe ALL
-- customers (never the current search), so they are loaded on their own and
-- are not re-fetched when the admin searches or changes page.
--
-- The month boundaries come from the browser (p_month_start inclusive,
-- p_month_end exclusive) so "new this month" keeps meaning the admin's local
-- calendar month, exactly as the old JS did.
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
          and coalesce(p.phone_number, '') <> '')
  );
$$;

revoke all on function public.get_admin_customer_stats(timestamptz, timestamptz) from public, anon;
grant execute on function public.get_admin_customer_stats(timestamptz, timestamptz) to authenticated;

-- Make the API pick up the two new functions immediately.
notify pgrst, 'reload schema';
