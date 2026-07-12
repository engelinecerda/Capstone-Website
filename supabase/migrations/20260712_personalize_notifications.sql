-- Personalize Manager-facing notifications with customer name + record reference,
-- and embed the related record id in `link` so the header notification bell can
-- deep-link straight to the reservation/contract/payment (?reservation=<id>).
-- Customer-facing notifications (still generic) are untouched.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 1. New reservation / cancellation request → Manager only ────────────────
CREATE OR REPLACE FUNCTION notify_admins_on_reservation()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO notifications (user_id, type, title, body, link)
    SELECT user_id,
           'admin_new_reservation',
           'New reservation submitted',
           'New reservation from ' || COALESCE(NEW.contact_name, 'a customer')
             || ' — ' || COALESCE(NEW.event_type, 'Event')
             || COALESCE(', ' || to_char(NEW.event_date, 'Mon DD'), ''),
           '/admin/reservations.html?reservation=' || NEW.reservation_id
    FROM profiles WHERE role = 'manager';

  ELSIF TG_OP = 'UPDATE'
    AND NEW.status = 'cancellation_requested'
    AND (OLD.status IS DISTINCT FROM 'cancellation_requested') THEN
    INSERT INTO notifications (user_id, type, title, body, link)
    SELECT user_id,
           'admin_cancellation_request',
           'Cancellation requested',
           COALESCE(NEW.contact_name, 'A customer') || ' requested to cancel '
             || COALESCE(NEW.reservation_number, 'their reservation')
             || ' — ' || COALESCE(NEW.event_type, 'Event'),
           '/admin/reservations.html?reservation=' || NEW.reservation_id
    FROM profiles WHERE role = 'manager';
  END IF;

  RETURN NEW;
END;
$$;

-- ── 2. Contract submitted → Manager only ─────────────────────────────────────
CREATE OR REPLACE FUNCTION notify_on_contract_review()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_user_id           uuid;
  v_contact_name      text;
  v_reservation_number text;
BEGIN
  IF NEW.review_status IS NOT DISTINCT FROM OLD.review_status THEN RETURN NEW; END IF;

  IF NEW.review_status = 'rejected' THEN
    SELECT r.user_id INTO v_user_id
    FROM reservations r WHERE r.reservation_id = NEW.reservation_id;

    IF v_user_id IS NOT NULL THEN
      INSERT INTO notifications (user_id, type, title, body, link)
      VALUES (v_user_id,
              'contract_rejected',
              'Contract Rejected',
              'Your uploaded contract was rejected. Please check the admin notes and resubmit a corrected copy.',
              '/account.html');
    END IF;
  END IF;

  IF NEW.review_status = 'pending_review' THEN
    SELECT r.contact_name, r.reservation_number
      INTO v_contact_name, v_reservation_number
    FROM reservations r WHERE r.reservation_id = NEW.reservation_id;

    INSERT INTO notifications (user_id, type, title, body, link)
    SELECT user_id,
           'admin_contract_submitted',
           'Contract submitted',
           'Contract uploaded by ' || COALESCE(v_contact_name, 'a customer')
             || ' for ' || COALESCE(v_reservation_number, 'a reservation'),
           '/admin/contracts.html?reservation=' || NEW.reservation_id
    FROM profiles WHERE role = 'manager';
  END IF;

  RETURN NEW;
END;
$$;

-- ── 3. Payment submitted → Manager only ──────────────────────────────────────
CREATE OR REPLACE FUNCTION notify_admins_on_new_payment()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_contact_name      text;
  v_reservation_number text;
BEGIN
  IF NEW.payment_status = 'pending_review' THEN
    SELECT r.contact_name, r.reservation_number
      INTO v_contact_name, v_reservation_number
    FROM reservations r WHERE r.reservation_id = NEW.reservation_id;

    INSERT INTO notifications (user_id, type, title, body, link)
    SELECT user_id,
           'admin_payment_submitted',
           'Payment submitted',
           'Payment proof submitted for ' || COALESCE(v_reservation_number, 'a reservation')
             || ' by ' || COALESCE(v_contact_name, 'a customer'),
           '/admin/payments.html?reservation=' || NEW.reservation_id
    FROM profiles WHERE role = 'manager';
  END IF;
  RETURN NEW;
END;
$$;

-- ── 4. Reschedule request submitted → Manager ─────────────────────────────────
CREATE OR REPLACE FUNCTION notify_manager_on_reschedule_request()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_contact_name      text;
  v_reservation_number text;
BEGIN
  SELECT r.contact_name, r.reservation_number
    INTO v_contact_name, v_reservation_number
  FROM reservations r WHERE r.reservation_id = NEW.reservation_id;

  INSERT INTO notifications (user_id, type, title, body, link)
  SELECT user_id,
         'admin_reschedule_request',
         'Reschedule requested',
         COALESCE(v_contact_name, 'A customer') || ' requested to reschedule '
           || COALESCE(v_reservation_number, 'their reservation')
           || COALESCE(' to ' || to_char(NEW.requested_date, 'Mon DD'), ''),
         '/admin/reservations.html?reservation=' || NEW.reservation_id
  FROM profiles WHERE role = 'manager';

  RETURN NEW;
END;
$$;
