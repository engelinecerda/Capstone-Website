-- ═══════════════════════════════════════════════════════════════════════════
-- Admin reservations list: flag bookings where the customer removed inclusions
--
-- get_admin_reservations_page() now also returns, per row,
--   inclusions_removed     how many optional inclusions the customer removed
--   inclusion_adjustment   pesos taken off the package price for them
-- so the list can show a "Customized" tag and the admin notices it BEFORE
-- approving. Everything else is the 20261116 definition, unchanged (same
-- arguments and jsonb return type, so no drop is needed and grants carry over).
--
-- Needs 20261123_customizable_inclusions.sql first (adds the columns read here).
-- Safe to re-run.
-- ═══════════════════════════════════════════════════════════════════════════

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
             r.inclusion_adjustment,
             (select count(*)
                from jsonb_array_elements(coalesce(r.inclusion_snapshot, '[]'::jsonb)) e
               where (e->>'removed')::boolean is true)::integer as inclusions_removed,
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
                     'inclusion_adjustment', pg.inclusion_adjustment,
                     'inclusions_removed',   pg.inclusions_removed,
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
