-- "Extra payment returned": tell the customer by EMAIL as well as in the app.
--
-- Until now mark_excess_returned() inserted a hardcoded in-app notification,
-- which never reached the customer's inbox. It now goes through
-- dispatch_notification() like the other money notices, so it follows the
-- Notifications settings (editable text, in-app + email on). It is marked not
-- disableable: a customer must always be told their money was sent back.
-- Only the notification part of mark_excess_returned() changed; the rest is
-- copied from 20261203_payment_excess.sql.
--
-- Also deploy the send-notification-email edge function (adds the button
-- label for this notice; without it the email still sends with a generic one).

insert into public.notification_trigger (code, label, description, is_disableable, sort_order) values
  ('payment_excess_returned', 'Extra payment returned',
   'Sent when a manager marks an extra payment as returned to the customer.', false, 10)
on conflict (code) do nothing;

insert into public.notification_template (trigger_code, is_enabled, send_in_app, send_email, email_subject, body) values
  ('payment_excess_returned', true, true, true, 'Your extra payment was returned',
   'Hi {{customer_name}}, we sent back {{amount_returned}} of your extra payment for reservation {{reservation_number}}. It may take 1–2 days to show in your account.')
on conflict (trigger_code) do nothing;

create or replace function public.mark_excess_returned(
  p_excess_id uuid,
  p_note      text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row     public.payment_excess%rowtype;
  v_user_id uuid;
begin
  if public.get_my_role() is distinct from 'manager' then
    raise exception 'Only a manager can mark an excess as returned.';
  end if;

  select * into v_row from public.payment_excess where excess_id = p_excess_id for update;
  if not found then
    raise exception 'Excess record could not be found.';
  end if;
  if v_row.return_status <> 'pending' then
    raise exception 'This excess is not waiting to be returned.';
  end if;

  update public.payment_excess
     set return_status = 'returned',
         returned_at   = now(),
         returned_by   = auth.uid(),
         return_note   = nullif(left(btrim(coalesce(p_note, '')), 500), '')
   where excess_id = p_excess_id;

  select r.user_id
    into v_user_id
  from public.reservations r
  where r.reservation_id = v_row.reservation_id;

  -- In-app AND email, through the notification templates (editable under
  -- Notifications settings). The reservation details are merged in first, then
  -- the amount that was sent back.
  if v_user_id is not null then
    perform public.dispatch_notification(
      v_user_id,
      'payment_excess_returned',
      'payment_excess',
      '/notifications.html',
      public.build_notification_merge_data(v_row.reservation_id)
        || jsonb_build_object('amount_returned', '₱' || to_char(v_row.return_amount, 'FM999,999,990.00'))
    );
  end if;

  return jsonb_build_object('excess_id', p_excess_id, 'returned', v_row.return_amount);
end;
$$;

revoke all on function public.mark_excess_returned(uuid, text) from public, anon;
grant execute on function public.mark_excess_returned(uuid, text) to authenticated;

notify pgrst, 'reload schema';
