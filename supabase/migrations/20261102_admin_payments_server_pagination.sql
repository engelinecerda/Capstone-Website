-- 20261102_admin_payments_server_pagination.sql
--
-- Server-side pagination, filtering and search for the admin Payment records
-- page (js/admin_payments.js).
--
-- Before: every page load and every 60-second auto-refresh downloaded EVERY
-- payment (21 columns, including notes, proof URLs and the OCR JSON), then sent
-- seven follow-up requests (reservations, payment summaries, receipts,
-- reschedule requests, extensions, added-guest requests, payment methods), each
-- listing every id in the URL - and the page then filtered, searched, counted
-- and paged them in the browser.
-- After: the browser asks for one page of payments, already filtered and
-- searched in the database, and loads the four stat-card numbers in one small
-- separate call. The follow-up lookups now only list the ids on that one page.
--
-- Both functions are SECURITY INVOKER (same choice as get_admin_nav_counts(),
-- get_admin_reservations_page() and get_admin_reviews_page()): they run with
-- the caller's own permissions, so row-level security applies exactly as it did
-- for the old direct queries. They grant no extra visibility.
--
-- Behaviour kept identical to the old browser code:
--   * newest submission first (submitted_at DESC, as before; payment_id as a
--     tie-breaker so pages never repeat or skip a row)
--   * status filter: 'all', or the payment_status value (case-insensitive)
--   * reservation filter (?reservation=<id> deep link): exact id match
--   * search = case-insensitive "contains" over the same ten fields the old JS
--     checked: reservation number, contact name, contact email, package name,
--     event time, the raw payment_method, the payment_method_label snapshot,
--     the display label for the method, the display label for the payment type,
--     and the reference number. The two display labels are the ones the page
--     shows (PAYMENT_METHOD_LABELS / PAYMENT_TYPE_LABELS in the JS), reproduced
--     below - keep them in step if those maps change.
--     The term is matched literally (strpos), so %, _ and \ are ordinary
--     characters, as the old JS .includes() treated them.
--   * stat cards count ALL payments, never the current filter or search.
--
-- Rows come back as the same 21 columns the page used to select, so the rest
-- of the page (review modal, receipts, OCR, record-payment) is unchanged.

-- Display label for a payment method; mirrors getPaymentMethodLabel() in
-- js/admin_payments.js (known map, else 'No method recorded', else the raw
-- value with its first letter capitalised).
create or replace function public.payment_method_display_label(p_method text)
returns text
language sql
immutable
set search_path = public
as $$
  select case p_method
    when 'card'       then 'Debit / Credit Card'
    when 'bancnet'    then 'Bank Transfer'
    when 'gcash_maya' then 'E-Wallet'
    when 'cash'       then 'Cash'
    when 'gcash'      then 'GCash'
    when 'maya'       then 'Maya'
    when 'bpi'        then 'BPI'
    when 'bank'       then 'Bank Transfer'
    when 'ewallet'    then 'E-Wallet'
    else case
      when coalesce(p_method, '') = '' then 'No method recorded'
      else upper(left(p_method, 1)) || substr(p_method, 2)
    end
  end;
$$;

-- Display label for a payment type; mirrors getPaymentTypeLabel().
create or replace function public.payment_type_display_label(p_type text)
returns text
language sql
immutable
set search_path = public
as $$
  select case p_type
    when 'reservation_fee'    then 'Reservation Fee'
    when 'down_payment'       then 'Down Payment'
    when 'full_payment'       then 'Full Payment'
    when 'partial_payment'    then 'Custom Amount'
    when 'reschedule_fee'     then 'Reschedule Fee'
    when 'cancellation_fee'   then 'Cancellation Fee'
    when 'extension_fee'      then 'Extension Fee'
    when 'additional_head_fee' then 'Additional Guests Fee'
    else coalesce(nullif(p_type, ''), 'Payment')
  end;
$$;

create or replace function public.get_admin_payments_page(
  p_status         text default 'all',
  p_search         text default null,
  p_reservation_id text default null,
  p_limit          integer default 20,
  p_offset         integer default 0
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
begin
  with matched as (
    select p.*,
           res.reservation_number,
           res.contact_name,
           res.contact_email,
           res.event_time,
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
  page as (
    select f.*
      from filtered f
     order by f.submitted_at desc, f.payment_id desc
     limit v_limit offset v_offset
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
                                order by pg.submitted_at desc, pg.payment_id desc
                              )
                         from page pg),
                      '[]'::jsonb)
         )
    into v_result;

  return v_result;
end;
$$;

revoke all on function public.get_admin_payments_page(text, text, text, integer, integer) from public, anon;
grant execute on function public.get_admin_payments_page(text, text, text, integer, integer) to authenticated;


-- The four stat cards on the Payment records page. They always describe ALL
-- payments (never the current filter or search), so they are loaded on their
-- own and are not re-fetched when the admin searches or changes page.
create or replace function public.get_admin_payment_counts()
returns jsonb
language sql
stable
security invoker
set search_path = public
as $$
  select jsonb_build_object(
    'total',          count(*),
    'pending_review', count(*) filter (where lower(coalesce(p.payment_status, '')) = 'pending_review'),
    'approved',       count(*) filter (where lower(coalesce(p.payment_status, '')) = 'approved'),
    'rejected',       count(*) filter (where lower(coalesce(p.payment_status, '')) = 'rejected')
  )
  from public.payment p;
$$;

revoke all on function public.get_admin_payment_counts() from public, anon;
grant execute on function public.get_admin_payment_counts() to authenticated;


-- Newest-first ordering for the page (matches ORDER BY submitted_at DESC,
-- payment_id DESC, including NULLs first, which is the DESC default).
create index if not exists payment_submitted_at_idx
  on public.payment (submitted_at desc, payment_id desc);
