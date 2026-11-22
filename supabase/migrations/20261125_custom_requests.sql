-- ═══════════════════════════════════════════════════════════════════════════
-- Custom requests (customizable inclusions, phase 2)
--
-- A customer can ask for something that is not in a package's inclusions,
-- when booking or any time afterwards while the reservation is still active:
--
--   pending  --quote-->  quoted  --accept-->  accepted   (becomes a charge)
--      \                    \
--       +-- declined <-------+   (by the manager: "can't do it", or by the
--                                 customer: withdraws / rejects the quote)
--
-- The manager sets the price; the customer accepts or declines it. ACCEPTING
-- adds a row to reservation_charges (20261022): the same "manual charge" a
-- manager can add by hand. It raises the reservation's effective total and is
-- paid down through the normal payment flow, and reservations.total_price is
-- never touched, so the signed contract stays frozen at its signed total.
--
-- No client can write this table. There is no INSERT/UPDATE/DELETE policy:
-- every transition runs through one of the guarded SECURITY DEFINER functions
-- below, the same approach reservation_extensions and the additional-head
-- requests use. Each function checks who is calling, the request's current
-- status, and that the reservation is still active.
--
-- Needs 20261123_customizable_inclusions.sql first (inclusion_catalog).
-- Safe to re-run.
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists public.reservation_custom_requests (
  request_id     uuid primary key default gen_random_uuid(),
  reservation_id uuid not null references public.reservations(reservation_id) on delete cascade,
  title          text not null check (length(btrim(title)) between 1 and 120),
  details        text check (details is null or length(details) <= 1000),
  status         text not null default 'pending'
                   check (status in ('pending', 'quoted', 'accepted', 'declined')),
  -- Optional link to the catalog item the manager matched the request to; its
  -- price only pre-fills the quote, the quoted price below is what counts.
  catalog_id     uuid references public.inclusion_catalog(inclusion_id) on delete set null,
  quoted_price   numeric(12,2) check (quoted_price is null or quoted_price > 0),
  quote_note     text check (quote_note is null or length(quote_note) <= 1000),
  quoted_by      uuid references auth.users(id) on delete set null,
  quoted_at      timestamptz,
  decided_at     timestamptz,
  declined_by    text check (declined_by is null or declined_by in ('admin', 'customer')),
  decline_reason text check (decline_reason is null or length(decline_reason) <= 1000),
  -- The charge an accepted request created.
  charge_id      uuid references public.reservation_charges(charge_id) on delete set null,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  constraint custom_request_quote_present check (
    status in ('pending', 'declined') or quoted_price is not null
  )
);

create index if not exists reservation_custom_requests_reservation_id_idx
  on public.reservation_custom_requests (reservation_id);

create index if not exists reservation_custom_requests_open_idx
  on public.reservation_custom_requests (status)
  where status in ('pending', 'quoted');

alter table public.reservation_custom_requests enable row level security;

drop policy if exists "customer_select_own_custom_requests" on public.reservation_custom_requests;
create policy "customer_select_own_custom_requests"
  on public.reservation_custom_requests for select
  using (
    exists (
      select 1 from public.reservations r
      where r.reservation_id = reservation_custom_requests.reservation_id
        and r.user_id = auth.uid()
    )
  );

drop policy if exists "staff_select_all_custom_requests" on public.reservation_custom_requests;
create policy "staff_select_all_custom_requests"
  on public.reservation_custom_requests for select
  using (public.get_my_role() in ('manager', 'admin', 'staff'));

grant select on public.reservation_custom_requests to authenticated;

-- ── Shared guard: the reservation must still be active ───────────────────────
-- Same statuses the capacity rules treat as live, and the event must not be in
-- the past. Returns the reservation row, or raises a customer-readable error.
create or replace function public.custom_request_open_reservation(p_reservation_id uuid)
returns public.reservations
language plpgsql
security definer
set search_path = public
as $$
declare
  v_res public.reservations%rowtype;
begin
  select * into v_res from public.reservations where reservation_id = p_reservation_id;

  if v_res.reservation_id is null then
    raise exception using errcode = 'P0001', message = 'Reservation not found.';
  end if;

  if lower(coalesce(v_res.status, '')) not in
       ('pending', 'approved', 'confirmed', 'partially_paid', 'fully_paid', 'rescheduled') then
    raise exception using errcode = 'P0001',
      message = 'Requests can only be made on an active reservation.';
  end if;

  if v_res.event_date < (now() at time zone 'Asia/Manila')::date then
    raise exception using errcode = 'P0001',
      message = 'This reservation’s date has already passed.';
  end if;

  return v_res;
end;
$$;

-- ── Customer: send a request ────────────────────────────────────────────────
create or replace function public.submit_custom_request(
  p_reservation_id uuid,
  p_title          text,
  p_details        text default null
)
returns public.reservation_custom_requests
language plpgsql
security definer
set search_path = public
as $$
declare
  v_res     public.reservations%rowtype;
  v_title   text := btrim(coalesce(p_title, ''));
  v_details text := nullif(btrim(coalesce(p_details, '')), '');
  v_open    int;
  v_row     public.reservation_custom_requests%rowtype;
begin
  if auth.uid() is null then
    raise exception using errcode = 'P0001', message = 'Not authorized.';
  end if;

  select * into v_res from public.reservations where reservation_id = p_reservation_id;
  if v_res.reservation_id is null or v_res.user_id is distinct from auth.uid() then
    raise exception using errcode = 'P0001', message = 'Not authorized.';
  end if;

  perform public.custom_request_open_reservation(p_reservation_id);

  if v_title = '' then
    raise exception using errcode = 'P0001', message = 'Tell us what you would like to request.';
  end if;
  if length(v_title) > 120 then
    raise exception using errcode = 'P0001', message = 'Keep the request title to 120 characters or fewer.';
  end if;
  if v_details is not null and length(v_details) > 1000 then
    raise exception using errcode = 'P0001', message = 'Keep the details to 1,000 characters or fewer.';
  end if;

  select count(*) into v_open
  from public.reservation_custom_requests
  where reservation_id = p_reservation_id and status in ('pending', 'quoted');
  if v_open >= 10 then
    raise exception using errcode = 'P0001',
      message = 'You already have 10 open requests on this reservation. Please wait for a reply before adding more.';
  end if;

  insert into public.reservation_custom_requests (reservation_id, title, details)
  values (p_reservation_id, v_title, v_details)
  returning * into v_row;

  insert into public.notifications (user_id, type, title, body, link)
  select p.user_id, 'admin_custom_request', 'New Custom Request',
         format('%s asked for “%s”. It needs a quote.', coalesce(nullif(btrim(v_res.contact_name), ''), 'A customer'), v_title),
         '/admin/reservation-details.html?id=' || p_reservation_id
  from public.profiles p
  where p.role in ('manager', 'admin');

  return v_row;
end;
$$;

-- ── Manager: set or change the price ────────────────────────────────────────
create or replace function public.quote_custom_request(
  p_request_id uuid,
  p_price      numeric,
  p_note       text default null,
  p_catalog_id uuid default null
)
returns public.reservation_custom_requests
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row   public.reservation_custom_requests%rowtype;
  v_res   public.reservations%rowtype;
  v_price numeric(12,2);
  v_note  text := nullif(btrim(coalesce(p_note, '')), '');
begin
  -- coalesce: a caller with no role at all must be refused too (NULL NOT IN
  -- (...) is NULL, not true, so a bare comparison would let them through).
  if coalesce(public.get_my_role(), '') not in ('manager', 'admin') then
    raise exception using errcode = 'P0001', message = 'Not authorized.';
  end if;

  select * into v_row from public.reservation_custom_requests where request_id = p_request_id for update;
  if v_row.request_id is null then
    raise exception using errcode = 'P0001', message = 'Request not found.';
  end if;
  if v_row.status not in ('pending', 'quoted') then
    raise exception using errcode = 'P0001', message = 'This request has already been closed.';
  end if;

  v_res := public.custom_request_open_reservation(v_row.reservation_id);

  if p_price is null or p_price <= 0 or p_price > 1000000 then
    raise exception using errcode = 'P0001', message = 'Enter a price greater than zero.';
  end if;
  v_price := round(p_price, 2);

  if v_note is not null and length(v_note) > 1000 then
    raise exception using errcode = 'P0001', message = 'Keep the note to 1,000 characters or fewer.';
  end if;

  if p_catalog_id is not null
     and not exists (select 1 from public.inclusion_catalog where inclusion_id = p_catalog_id) then
    raise exception using errcode = 'P0001', message = 'That catalog item no longer exists.';
  end if;

  update public.reservation_custom_requests
  set status       = 'quoted',
      quoted_price = v_price,
      quote_note   = v_note,
      catalog_id   = p_catalog_id,
      quoted_by    = auth.uid(),
      quoted_at    = now(),
      updated_at   = now()
  where request_id = p_request_id
  returning * into v_row;

  if v_res.user_id is not null then
    insert into public.notifications (user_id, type, title, body, link)
    values (
      v_res.user_id,
      'reservation_status',
      'Your Request Has a Quote',
      format('“%s” is quoted at ₱%s. Review it and accept or decline.', v_row.title, to_char(v_price, 'FM999,999,990.00')),
      '/reservation-details.html?reservation_id=' || v_row.reservation_id
    );
  end if;

  return v_row;
end;
$$;

-- ── Customer: accept the quote (becomes a charge) ──────────────────────────────
create or replace function public.accept_custom_request(p_request_id uuid)
returns public.reservation_custom_requests
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row    public.reservation_custom_requests%rowtype;
  v_res    public.reservations%rowtype;
  v_charge uuid;
begin
  if auth.uid() is null then
    raise exception using errcode = 'P0001', message = 'Not authorized.';
  end if;

  select * into v_row from public.reservation_custom_requests where request_id = p_request_id for update;
  if v_row.request_id is null then
    raise exception using errcode = 'P0001', message = 'Request not found.';
  end if;

  select * into v_res from public.reservations where reservation_id = v_row.reservation_id;
  if v_res.user_id is distinct from auth.uid() then
    raise exception using errcode = 'P0001', message = 'Not authorized.';
  end if;

  if v_row.status <> 'quoted' then
    raise exception using errcode = 'P0001',
      message = case v_row.status
        when 'accepted' then 'You have already accepted this quote.'
        when 'declined' then 'This request was closed.'
        else 'This request has not been quoted yet.' end;
  end if;

  perform public.custom_request_open_reservation(v_row.reservation_id);

  insert into public.reservation_charges (reservation_id, label, amount, note, added_by)
  values (
    v_row.reservation_id,
    left('Custom request: ' || v_row.title, 200),
    v_row.quoted_price,
    v_row.quote_note,
    v_row.quoted_by
  )
  returning charge_id into v_charge;

  update public.reservation_custom_requests
  set status = 'accepted', decided_at = now(), charge_id = v_charge, updated_at = now()
  where request_id = p_request_id
  returning * into v_row;

  insert into public.notifications (user_id, type, title, body, link)
  select p.user_id, 'admin_custom_request', 'Custom Request Accepted',
         format('%s accepted “%s” (₱%s). It was added to the reservation as a charge.',
                coalesce(nullif(btrim(v_res.contact_name), ''), 'The customer'), v_row.title,
                to_char(v_row.quoted_price, 'FM999,999,990.00')),
         '/admin/reservation-details.html?id=' || v_row.reservation_id
  from public.profiles p
  where p.role in ('manager', 'admin');

  return v_row;
end;
$$;

-- ── Either side: close a request ─────────────────────────────────────────────
-- The customer can withdraw a pending request or reject a quote; a manager can
-- decline a request they can't do, or withdraw a quote.
create or replace function public.decline_custom_request(
  p_request_id uuid,
  p_reason     text default null
)
returns public.reservation_custom_requests
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row    public.reservation_custom_requests%rowtype;
  v_res    public.reservations%rowtype;
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
  v_by     text;
begin
  if auth.uid() is null then
    raise exception using errcode = 'P0001', message = 'Not authorized.';
  end if;

  if v_reason is not null and length(v_reason) > 1000 then
    raise exception using errcode = 'P0001', message = 'Keep the reason to 1,000 characters or fewer.';
  end if;

  select * into v_row from public.reservation_custom_requests where request_id = p_request_id for update;
  if v_row.request_id is null then
    raise exception using errcode = 'P0001', message = 'Request not found.';
  end if;

  select * into v_res from public.reservations where reservation_id = v_row.reservation_id;

  if public.get_my_role() in ('manager', 'admin') then
    v_by := 'admin';
  elsif v_res.user_id = auth.uid() then
    v_by := 'customer';
  else
    raise exception using errcode = 'P0001', message = 'Not authorized.';
  end if;

  if v_row.status not in ('pending', 'quoted') then
    raise exception using errcode = 'P0001', message = 'This request has already been closed.';
  end if;

  update public.reservation_custom_requests
  set status = 'declined', declined_by = v_by, decline_reason = v_reason,
      decided_at = now(), updated_at = now()
  where request_id = p_request_id
  returning * into v_row;

  if v_by = 'admin' and v_res.user_id is not null then
    insert into public.notifications (user_id, type, title, body, link)
    values (
      v_res.user_id,
      'reservation_status',
      'Request Update',
      format('We can’t take “%s” on.%s', v_row.title, case when v_reason is null then '' else ' ' || v_reason end),
      '/reservation-details.html?reservation_id=' || v_row.reservation_id
    );
  elsif v_by = 'customer' then
    insert into public.notifications (user_id, type, title, body, link)
    select p.user_id, 'admin_custom_request', 'Custom Request Closed',
           format('%s closed their request “%s”.', coalesce(nullif(btrim(v_res.contact_name), ''), 'The customer'), v_row.title),
           '/admin/reservation-details.html?id=' || v_row.reservation_id
    from public.profiles p
    where p.role in ('manager', 'admin');
  end if;

  return v_row;
end;
$$;

-- ── Admin: turn a request people keep making into a catalog item ──────────────
-- The catalog is managed by the admin role only (see inclusion_catalog's
-- policies), so this is too.
create or replace function public.promote_custom_request_to_catalog(
  p_request_id uuid,
  p_name       text,
  p_price      numeric
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row  public.reservation_custom_requests%rowtype;
  v_name text := btrim(coalesce(p_name, ''));
  v_id   uuid;
begin
  if coalesce(public.get_my_role(), '') <> 'admin' then
    raise exception using errcode = 'P0001', message = 'Not authorized.';
  end if;

  select * into v_row from public.reservation_custom_requests where request_id = p_request_id for update;
  if v_row.request_id is null then
    raise exception using errcode = 'P0001', message = 'Request not found.';
  end if;
  if v_row.status not in ('quoted', 'accepted') then
    raise exception using errcode = 'P0001', message = 'Only a quoted or accepted request can be added to the catalog.';
  end if;
  if v_name = '' then
    raise exception using errcode = 'P0001', message = 'Enter a name for the catalog item.';
  end if;
  if p_price is null or p_price < 0 or p_price > 1000000 then
    raise exception using errcode = 'P0001', message = 'Enter a price of ₱0 or more.';
  end if;

  begin
    insert into public.inclusion_catalog (name, price, is_active)
    values (v_name, round(p_price, 2), true)
    returning inclusion_id into v_id;
  exception when unique_violation then
    raise exception using errcode = 'P0001', message = 'An inclusion with that name already exists.';
  end;

  update public.reservation_custom_requests
  set catalog_id = v_id, updated_at = now()
  where request_id = p_request_id;

  return v_id;
end;
$$;

-- Callable by signed-in users only; each function enforces who may do what.
revoke all on function public.custom_request_open_reservation(uuid) from public, anon, authenticated;
revoke all on function public.submit_custom_request(uuid, text, text) from public, anon;
revoke all on function public.quote_custom_request(uuid, numeric, text, uuid) from public, anon;
revoke all on function public.accept_custom_request(uuid) from public, anon;
revoke all on function public.decline_custom_request(uuid, text) from public, anon;
revoke all on function public.promote_custom_request_to_catalog(uuid, text, numeric) from public, anon;

grant execute on function public.submit_custom_request(uuid, text, text) to authenticated;
grant execute on function public.quote_custom_request(uuid, numeric, text, uuid) to authenticated;
grant execute on function public.accept_custom_request(uuid) to authenticated;
grant execute on function public.decline_custom_request(uuid, text) to authenticated;
grant execute on function public.promote_custom_request_to_catalog(uuid, text, numeric) to authenticated;
