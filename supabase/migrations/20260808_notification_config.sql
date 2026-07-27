-- Notifications Configuration, Phase 1.
--
-- Every notification today is created by 5 SECURITY DEFINER trigger
-- functions in 20260513_create_notifications.sql / 20260617_fix_notification_
-- routing.sql, each hardcoding title/body via a CASE statement — there is
-- no client-side .insert() into notifications anywhere (confirmed by a
-- full-codebase search) and send-notification-email is a generic relay that
-- just emails whatever title/body a row already has. This migration moves
-- 7 specific branches (the spec's fixed trigger catalogue) out of those
-- CASE statements into notification_template, seeded with today's real
-- wording so nothing changes for customers until an admin edits something.
-- Every other branch these functions handle (declined/for_finalization/
-- completed reservation-status cases, every admin_* alert, contract review)
-- is NOT in the spec's 7-trigger catalogue and is copied through unchanged.

-- ═══════════════════════════════════════════════════════════════════════════
-- 1. SCHEMA
-- ═══════════════════════════════════════════════════════════════════════════

create table if not exists public.notification_trigger (
  code           text primary key,
  label          text not null,
  description    text not null,
  is_disableable boolean not null default true,
  sort_order     int not null default 0
);

insert into public.notification_trigger (code, label, description, is_disableable, sort_order) values
  ('reservation_submitted',   'Reservation submitted',   'Sent when a customer submits a reservation.', true, 1),
  ('reservation_confirmed',   'Reservation confirmed',   'Sent when a reservation is approved and held.', true, 2),
  ('payment_received',        'Payment received',        'Sent when a payment is approved.', true, 3),
  ('payment_rejected',        'Payment rejected',        'Sent when a payment is rejected, with the reason.', false, 4),
  ('reschedule_confirmed',    'Reschedule confirmed',    'Sent when a reschedule is approved.', true, 5),
  ('cancellation_confirmed',  'Cancellation confirmed',  'Sent when a cancellation is processed.', false, 6),
  ('contract_ready',          'Contract ready',          'Sent when the contract is ready to sign.', true, 7)
on conflict (code) do nothing;

create table if not exists public.notification_template (
  trigger_code  text primary key references public.notification_trigger(code),
  is_enabled    boolean not null default true,
  send_in_app   boolean not null default true,
  send_email    boolean not null default true,
  email_subject text,
  body          text not null,
  updated_at    timestamptz not null default now(),
  updated_by    uuid references auth.users(id)
);

-- Seeded verbatim from the current hardcoded strings (see file header) —
-- reservation_submitted is the one exception, a genuinely new customer
-- notice (confirmed with the user), and payment_rejected's body gains the
-- {{rejection_reason}} line the spec requires but nothing captured before.
insert into public.notification_template (trigger_code, email_subject, body) values
  ('reservation_submitted', 'We received your reservation request',
   'Hi {{customer_name}}, we''ve received your reservation request for {{event_type}} on {{event_date}}. Our team will review it and get back to you shortly.'),
  ('reservation_confirmed', 'Your reservation is confirmed',
   'Great news, {{customer_name}} — your {{event_type}} reservation for {{event_date}} has been approved!'),
  ('payment_received', 'Payment confirmed',
   'Hi {{customer_name}}, your payment of {{amount_paid}} has been reviewed and confirmed. Remaining balance: {{remaining_balance}}.'),
  ('payment_rejected', 'Payment rejected',
   'Hi {{customer_name}}, your payment submission was rejected. Reason: {{rejection_reason}}. Please review the details and resubmit.'),
  ('reschedule_confirmed', 'Reschedule approved — payment required',
   'Hi {{customer_name}}, your reschedule request has been approved. Please submit the reschedule fee to confirm the new date.'),
  ('cancellation_confirmed', 'Your reservation has been cancelled',
   'Hi {{customer_name}}, your {{event_type}} reservation has been cancelled. Contact us if you have any questions.'),
  ('contract_ready', 'Your contract is ready to sign',
   'Hi {{customer_name}}, your reservation is confirmed. Please upload your signed contract to proceed.')
on conflict (trigger_code) do nothing;

-- Extend the existing live table — not a parallel one.
alter table public.notifications
  add column if not exists trigger_code  text references public.notification_trigger(code),
  add column if not exists channel       text not null default 'in_app',
  add column if not exists status        text not null default 'sent',
  add column if not exists sent_at       timestamptz,
  add column if not exists error_message text;

-- The one new field the spec's own token requirement needs.
alter table public.payment add column if not exists rejection_reason text;

-- ═══════════════════════════════════════════════════════════════════════════
-- 2. RLS — notification_trigger has NO write policy at all (never
--    user-editable, not even by admin); notification_template is
--    admin read/write. notifications' existing 3 policies are untouched.
-- ═══════════════════════════════════════════════════════════════════════════

alter table public.notification_trigger enable row level security;
drop policy if exists "Admin read triggers" on public.notification_trigger;
create policy "Admin read triggers" on public.notification_trigger for select using (get_my_role() = 'admin');

alter table public.notification_template enable row level security;
drop policy if exists "Admin read templates" on public.notification_template;
create policy "Admin read templates" on public.notification_template for select using (get_my_role() = 'admin');
drop policy if exists "Admin manage templates" on public.notification_template;
create policy "Admin manage templates" on public.notification_template
  for all using (get_my_role() = 'admin') with check (get_my_role() = 'admin');

-- ═══════════════════════════════════════════════════════════════════════════
-- 3. HELPER FUNCTIONS
-- ═══════════════════════════════════════════════════════════════════════════

-- Same substitution semantics as js/merge_tokens.js's mergeTokens() regex
-- (\{\{\s*key\s*\}\}), just in plpgsql since this runs inside a trigger.
-- Unknown/missing tokens resolve to '' — the "block on unknown token" rule
-- is an admin-UI-time (save-time) concern, not a send-time one; a template
-- can never be saved with an unresolved token in the first place.
create or replace function public.render_notification_template(p_trigger_code text, p_data jsonb)
returns table (subject text, body text)
language plpgsql
as $$
declare
  v_template public.notification_template%rowtype;
  v_subject  text;
  v_body     text;
  v_key      text;
  v_val      text;
begin
  select * into v_template from public.notification_template where trigger_code = p_trigger_code;
  if not found then
    return;
  end if;

  v_subject := coalesce(v_template.email_subject, '');
  v_body := v_template.body;

  for v_key, v_val in select d.key, d.value from jsonb_each_text(coalesce(p_data, '{}'::jsonb)) d loop
    v_subject := regexp_replace(v_subject, '\{\{\s*' || v_key || '\s*\}\}', coalesce(v_val, ''), 'g');
    v_body    := regexp_replace(v_body,    '\{\{\s*' || v_key || '\s*\}\}', coalesce(v_val, ''), 'g');
  end loop;

  subject := v_subject;
  body := v_body;
  return next;
end;
$$;

-- Common merge data for a reservation — mirrors generate-signed-contract's
-- mergeData construction (supabase/functions/generate-signed-contract/
-- index.ts:832-841) field-for-field so the same token resolves identically
-- in a contract and a notification.
create or replace function public.build_notification_merge_data(p_reservation_id uuid)
returns jsonb
language plpgsql
as $$
declare
  v_data jsonb;
begin
  select jsonb_build_object(
    'customer_name', coalesce(r.contact_name, ''),
    'package_name', coalesce(pk.package_name, ''),
    'event_type', coalesce(r.event_type, 'TBD'),
    'event_date', coalesce(to_char(r.event_date, 'FMMonth FMDD, YYYY'), 'TBD'),
    'event_time', coalesce(r.event_time, 'TBD'),
    'venue', case
      when r.location_type = 'offsite' then coalesce(r.venue_location, '')
      else 'ELI Coffee Events Cafe Binangonan (Onsite)'
    end,
    'reservation_number', coalesce(r.reservation_number, ''),
    'total_price', '₱' || to_char(coalesce(r.total_price, 0), 'FM999,999,990.00'),
    'guest_count', coalesce(r.guest_count::text, ''),
    'amount_paid', '₱' || to_char(coalesce(s.total_paid, 0), 'FM999,999,990.00'),
    'remaining_balance', '₱' || to_char(coalesce(s.outstanding_balance, 0), 'FM999,999,990.00')
  )
  into v_data
  from public.reservations r
  left join public.package pk on pk.package_id = r.package_id
  left join public.reservation_payment_summary s on s.reservation_id = r.reservation_id
  where r.reservation_id = p_reservation_id;

  return coalesce(v_data, '{}'::jsonb);
end;
$$;

-- Looks up the template, skips entirely if disabled, inserts one row per
-- enabled channel. In-app rows are 'sent' immediately (existence =
-- delivered to the in-app store); email rows start 'pending' and are
-- updated by supabase/functions/send-notification-email after it actually
-- attempts the send.
create or replace function public.dispatch_notification(
  p_user_id uuid,
  p_trigger_code text,
  p_legacy_type text,
  p_link text,
  p_merge_data jsonb
)
returns void
language plpgsql
as $$
declare
  v_template public.notification_template%rowtype;
  v_trigger_label text;
  v_rendered record;
begin
  if p_user_id is null then return; end if;

  select * into v_template from public.notification_template where trigger_code = p_trigger_code;
  if not found or not v_template.is_enabled then
    return;
  end if;

  select label into v_trigger_label from public.notification_trigger where code = p_trigger_code;
  select * into v_rendered from public.render_notification_template(p_trigger_code, p_merge_data);

  if v_template.send_in_app then
    insert into public.notifications (user_id, type, title, body, link, trigger_code, channel, status)
    values (p_user_id, p_legacy_type, coalesce(v_trigger_label, 'Notification'), v_rendered.body, p_link, p_trigger_code, 'in_app', 'sent');
  end if;

  if v_template.send_email then
    insert into public.notifications (user_id, type, title, body, link, trigger_code, channel, status)
    values (p_user_id, p_legacy_type, coalesce(v_rendered.subject, v_trigger_label, 'Notification'), v_rendered.body, p_link, p_trigger_code, 'email', 'pending');
  end if;
end;
$$;

-- ═══════════════════════════════════════════════════════════════════════════
-- 4. TRIGGER FUNCTION REWRITES — only the 7 target branches change;
--    everything else in each function is copied through byte-identical.
-- ═══════════════════════════════════════════════════════════════════════════

-- 4a. Reservation status change → customer. Targets: approved, cancelled,
--     for_contract_signing. declined/for_finalization/completed unchanged.
create or replace function public.notify_customer_on_reservation_status()
returns trigger language plpgsql security definer as $$
declare
  v_merge_data jsonb;
begin
  if NEW.status is not distinct from OLD.status then return NEW; end if;

  case NEW.status
    when 'approved' then
      v_merge_data := public.build_notification_merge_data(NEW.reservation_id);
      perform public.dispatch_notification(NEW.user_id, 'reservation_confirmed', 'reservation_status', '/account.html', v_merge_data);
    when 'declined' then
      insert into notifications (user_id, type, title, body, link)
      values (NEW.user_id, 'reservation_status', 'Reservation Not Approved', 'Unfortunately, your reservation was not approved at this time.', '/account.html');
    when 'for_contract_signing' then
      v_merge_data := public.build_notification_merge_data(NEW.reservation_id);
      perform public.dispatch_notification(NEW.user_id, 'contract_ready', 'reservation_status', '/account.html', v_merge_data);
    when 'for_finalization' then
      insert into notifications (user_id, type, title, body, link)
      values (NEW.user_id, 'reservation_status', 'Contract Verified', 'Your signed contract has been verified. Your reservation is now moving to the finalization stage.', '/account.html');
    when 'completed' then
      insert into notifications (user_id, type, title, body, link)
      values (NEW.user_id, 'reservation_status', 'Reservation Complete', 'Your event reservation is now marked complete. Thank you for choosing ELI Coffee Events!', '/account.html');
    when 'cancelled' then
      v_merge_data := public.build_notification_merge_data(NEW.reservation_id);
      perform public.dispatch_notification(NEW.user_id, 'cancellation_confirmed', 'reservation_status', '/account.html', v_merge_data);
    else return NEW;
  end case;

  return NEW;
end;
$$;

-- 4b. Admin alerts on reservation INSERT/UPDATE. Target: adds the new
--     reservation_submitted customer insert alongside the existing
--     (untouched) admin_new_reservation alert. admin_cancellation_request
--     branch unchanged. Admin recipient clause preserved byte-for-byte from
--     the original migration, including its pre-existing 'super_admin'
--     value — not this migration's job to fix.
create or replace function public.notify_admins_on_reservation()
returns trigger language plpgsql security definer as $$
declare
  v_merge_data jsonb;
begin
  if TG_OP = 'INSERT' then
    insert into notifications (user_id, type, title, body, link)
    select user_id,
           'admin_new_reservation',
           'New Reservation Submitted',
           'A customer has submitted a new reservation awaiting your review.',
           '/admin/reservations.html'
    from profiles where role in ('admin', 'super_admin');

    v_merge_data := public.build_notification_merge_data(NEW.reservation_id);
    perform public.dispatch_notification(NEW.user_id, 'reservation_submitted', 'reservation_status', '/account.html', v_merge_data);

  elsif TG_OP = 'UPDATE'
    and NEW.status = 'cancellation_requested'
    and (OLD.status is distinct from 'cancellation_requested') then
    insert into notifications (user_id, type, title, body, link)
    select user_id,
           'admin_cancellation_request',
           'Cancellation Requested',
           'A customer has submitted a cancellation request for their reservation.',
           '/admin/reservations.html'
    from profiles where role in ('admin', 'super_admin');
  end if;

  return NEW;
end;
$$;

-- 4c. Payment status change → customer. Targets: approved, rejected.
create or replace function public.notify_customer_on_payment_status()
returns trigger language plpgsql security definer as $$
declare
  v_user_id uuid;
  v_merge_data jsonb;
begin
  if NEW.payment_status is not distinct from OLD.payment_status then return NEW; end if;

  select r.user_id into v_user_id from reservations r where r.reservation_id = NEW.reservation_id;
  if v_user_id is null then return NEW; end if;

  case NEW.payment_status
    when 'approved' then
      v_merge_data := public.build_notification_merge_data(NEW.reservation_id);
      perform public.dispatch_notification(v_user_id, 'payment_received', 'payment_status', '/account.html', v_merge_data);
    when 'rejected' then
      v_merge_data := public.build_notification_merge_data(NEW.reservation_id)
        || jsonb_build_object('rejection_reason', coalesce(NEW.rejection_reason, 'Not specified'));
      perform public.dispatch_notification(v_user_id, 'payment_rejected', 'payment_status', '/account.html', v_merge_data);
    else return NEW;
  end case;

  return NEW;
end;
$$;

-- 4d. Reschedule review → customer. Target: approved_pending_payment only;
--     rejected branch unchanged.
create or replace function public.notify_customer_on_reschedule_review()
returns trigger language plpgsql security definer as $$
declare
  v_user_id uuid;
  v_merge_data jsonb;
begin
  if NEW.status is not distinct from OLD.status then return NEW; end if;

  select r.user_id into v_user_id from reservations r where r.reservation_id = NEW.reservation_id;

  case NEW.status
    when 'approved_pending_payment' then
      if v_user_id is not null then
        v_merge_data := public.build_notification_merge_data(NEW.reservation_id);
        perform public.dispatch_notification(v_user_id, 'reschedule_confirmed', 'reschedule_review', '/account.html', v_merge_data);
      end if;
    when 'rejected' then
      if v_user_id is not null then
        insert into notifications (user_id, type, title, body, link)
        values (v_user_id, 'reschedule_review', 'Reschedule Request Declined', 'Your reschedule request was declined. Please contact us if you have any questions.', '/account.html');
      end if;
    else return NEW;
  end case;

  return NEW;
end;
$$;

-- Not touched: notify_on_contract_review() (contract_rejected /
-- admin_contract_submitted — neither is in the 7-trigger catalogue),
-- notify_admins_on_new_payment() (admin-only), notify_manager_on_
-- reschedule_request() (admin-only). Triggers already bound to all 5
-- rewritten functions stay bound — create or replace function preserves
-- them.
