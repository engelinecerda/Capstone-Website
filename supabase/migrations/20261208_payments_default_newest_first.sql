-- Payment management: with no column sorted, list the NEWEST submitted payments
-- first (for every status chip) instead of alphabetically by customer.
-- Only the default ordering changed; everything else is copied from
-- 20261116_sortable_admin_lists.sql. Safe to re-run.

create or replace function public.get_admin_payments_page(
  p_status         text default 'all',
  p_search         text default null,
  p_reservation_id text default null,
  p_limit          integer default 20,
  p_offset         integer default 0,
  p_sort_key       text    default null,   -- reservation | customer | amount (null = newest submitted first)
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
  -- No (or an unknown) sort key means newest submitted payment first. That
  -- is every ordering key's tie-breaker below, so no key branch matches.
  if v_sort_key is null or v_sort_key not in ('reservation', 'customer', 'amount') then
    v_sort_key := 'submitted';
    v_desc := true;
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
             f.submitted_at desc nulls last,
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

notify pgrst, 'reload schema';
