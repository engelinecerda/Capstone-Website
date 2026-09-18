-- Inquiry feature, Phase 1 — a pre-booking lead-capture form, separate from
-- the reservation flow, digitizing the café's physical intake sheet.
--
-- Two new tables:
--   referral_sources — admin-configurable lookup ("How did you hear about
--     us?"), same is_active/sort_order shape as event_types/package_category
--     so it plugs into the existing admin repeatable-list conventions.
--   inquiries — one row per submission. Requires an authenticated account
--     (user_id not null, RLS insert checked against auth.uid()) — there is
--     no guest-submission path, matching the page-load auth gate in front
--     of the customer-facing form.
--
-- Notifications reuse the existing table-driven catalogue
-- (notification_trigger/notification_template/dispatch_notification, see
-- 20260808_notification_config.sql) exactly the way reservation_submitted
-- does: a plain broadcast insert to every 'manager' profile for the staff
-- bell, plus a templated dispatch_notification() call for the customer's
-- in-app + email confirmation. The customer confirmation's turnaround-days
-- wording lives in notification_template.body (admin-editable from
-- admin/config/notifications.html, no code change needed to adjust it).
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 1. referral_sources ──────────────────────────────────────────────────────
create table if not exists public.referral_sources (
  id          uuid primary key default gen_random_uuid(),
  label       text not null,
  sort_order  integer not null default 0,
  is_active   boolean not null default true,
  created_at  timestamptz not null default now()
);

alter table public.referral_sources enable row level security;

drop policy if exists "Public can read active referral sources" on public.referral_sources;
create policy "Public can read active referral sources"
  on public.referral_sources for select
  using (is_active = true);

drop policy if exists "Manager and admin can read all referral sources" on public.referral_sources;
create policy "Manager and admin can read all referral sources"
  on public.referral_sources for select
  using (get_my_role() in ('manager', 'admin'));

-- Admin is read-only here (Model B — same as everywhere else operational in
-- this system); only Manager can add/edit/reorder/deactivate.
drop policy if exists "Manager can manage referral sources" on public.referral_sources;
create policy "Manager can manage referral sources"
  on public.referral_sources for all
  using (get_my_role() = 'manager')
  with check (get_my_role() = 'manager');

grant select on public.referral_sources to anon, authenticated;
grant insert, update, delete on public.referral_sources to authenticated;

create index if not exists idx_referral_sources_sort_order on public.referral_sources (sort_order);

-- Seed only on first creation of this table — safe to re-run, never
-- overwrites an admin's later edits/reorders.
insert into public.referral_sources (label, sort_order, is_active)
select v.label, v.sort_order, true
from (values
  ('Facebook', 1),
  ('Instagram', 2),
  ('Google Search', 3),
  ('Walk-in', 4),
  ('Friend/Family Referral', 5),
  ('Other', 6)
) as v(label, sort_order)
where not exists (select 1 from public.referral_sources);

-- ── 2. inquiries ──────────────────────────────────────────────────────────────
-- Field named user_id (not customer_id) to match reservations.user_id and
-- every other customer-owned table in this schema — there is no separate
-- "customers" table, identity is auth.users + profiles(user_id) throughout.
create table if not exists public.inquiries (
  id                       uuid primary key default gen_random_uuid(),
  user_id                  uuid not null references auth.users(id) on delete cascade,
  inquiry_date             timestamptz not null default now(),
  full_name                text not null,
  event_type_id            uuid references public.event_types(id),
  event_date               date,
  target_guest_count       integer,
  email                    text not null,
  mobile_number            text,
  referral_source_id       uuid references public.referral_sources(id),
  remarks                  text,
  status                   text not null default 'new' check (status in ('new', 'contacted', 'converted', 'closed')),
  internal_note            text,
  converted_reservation_id uuid references public.reservations(reservation_id),
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now()
);

create index if not exists idx_inquiries_status on public.inquiries (status);
create index if not exists idx_inquiries_user_id on public.inquiries (user_id);
create index if not exists idx_inquiries_event_type_id on public.inquiries (event_type_id);
create index if not exists idx_inquiries_referral_source_id on public.inquiries (referral_source_id);
create index if not exists idx_inquiries_created_at on public.inquiries (created_at desc);

alter table public.inquiries enable row level security;

-- No customer-facing SELECT policy: the confirmation the customer sees
-- after submitting is a static "thanks" state, not a read-back of the row,
-- so there's no need to expose this table to the customer at all (that
-- also keeps internal_note — Manager-only — outside customer reach by
-- construction, not just by convention in the UI).
drop policy if exists "Customer can insert own inquiries" on public.inquiries;
create policy "Customer can insert own inquiries"
  on public.inquiries for insert
  with check (auth.uid() = user_id);

drop policy if exists "Manager and admin can read all inquiries" on public.inquiries;
create policy "Manager and admin can read all inquiries"
  on public.inquiries for select
  using (get_my_role() in ('manager', 'admin'));

-- Admin is read-only (item 7) — status changes, internal_note, and any
-- eventual converted_reservation_id are Manager-only actions.
drop policy if exists "Manager can update inquiries" on public.inquiries;
create policy "Manager can update inquiries"
  on public.inquiries for update
  using (get_my_role() = 'manager')
  with check (get_my_role() = 'manager');

grant select, insert on public.inquiries to authenticated;
grant update on public.inquiries to authenticated;

create or replace function public.set_inquiries_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists inquiries_set_updated_at on public.inquiries;
create trigger inquiries_set_updated_at
before update on public.inquiries
for each row execute function public.set_inquiries_updated_at();

-- ── 3. Notifications — staff broadcast + customer templated confirmation ──────
insert into public.notification_trigger (code, label, description, is_disableable, sort_order) values
  ('inquiry_received', 'Inquiry received', 'Sent to the customer after they submit an inquiry.', true, 8)
on conflict (code) do nothing;

-- {{turnaround_days}} is a placeholder pending the team confirming the real
-- SLA wording — edit this row's body from admin/config/notifications.html
-- at any time; no code change needed.
insert into public.notification_template (trigger_code, email_subject, body) values
  ('inquiry_received', 'We received your inquiry',
   'Hi {{customer_name}}, thank you for your inquiry about {{event_type}} on {{event_date}}. Our team will reach out within {{turnaround_days}} business days to help plan your event.')
on conflict (trigger_code) do nothing;

create or replace function public.notify_on_inquiry_submitted()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_event_type_name text;
  v_merge_data       jsonb;
begin
  select name into v_event_type_name from public.event_types where id = new.event_type_id;

  -- Staff broadcast — plain insert, same shape as notify_admins_on_reservation().
  insert into public.notifications (user_id, type, title, body, link)
  select user_id, 'admin_new_inquiry', 'New Inquiry Submitted',
         coalesce(new.full_name, 'A customer') || ' sent an inquiry'
           || case when v_event_type_name is not null then ' about a ' || v_event_type_name else '' end
           || '.',
         '/admin/inquiries'
  from public.profiles where role = 'manager';

  -- Customer confirmation — in-app + email via the templated catalogue.
  v_merge_data := jsonb_build_object(
    'customer_name',    coalesce(new.full_name, ''),
    'event_type',       coalesce(v_event_type_name, 'your event'),
    'event_date',        coalesce(to_char(new.event_date, 'FMMonth FMDD, YYYY'), 'a date to be discussed'),
    'turnaround_days',  '2'
  );
  perform public.dispatch_notification(new.user_id, 'inquiry_received', 'inquiry_status', '/account.html', v_merge_data);

  return new;
end;
$$;

drop trigger if exists inquiries_notify_on_insert on public.inquiries;
create trigger inquiries_notify_on_insert
after insert on public.inquiries
for each row execute function public.notify_on_inquiry_submitted();
