-- Fix notification routing: manager-only events must not reach super_admin (Admin role).
-- Also adds missing reschedule request notifications for Manager and Customer.
--
-- Role reminder (see session_validation.js):
--   role = 'admin'       →  Manager in UI  (operational)
--   role = 'super_admin' →  Admin in UI    (system/config)
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 1. New reservation → Manager only ────────────────────────────────────────
CREATE OR REPLACE FUNCTION notify_admins_on_reservation()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO notifications (user_id, type, title, body, link)
    SELECT user_id,
           'admin_new_reservation',
           'New Reservation Submitted',
           'A customer has submitted a new reservation awaiting your review.',
           '/admin/reservations.html'
    FROM profiles WHERE role = 'admin';

  ELSIF TG_OP = 'UPDATE'
    AND NEW.status = 'cancellation_requested'
    AND (OLD.status IS DISTINCT FROM 'cancellation_requested') THEN
    INSERT INTO notifications (user_id, type, title, body, link)
    SELECT user_id,
           'admin_cancellation_request',
           'Cancellation Requested',
           'A customer has submitted a cancellation request for their reservation.',
           '/admin/reservations.html'
    FROM profiles WHERE role = 'admin';
  END IF;

  RETURN NEW;
END;
$$;

-- ── 2. Contract submitted → Manager only ─────────────────────────────────────
CREATE OR REPLACE FUNCTION notify_on_contract_review()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_user_id uuid;
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
    INSERT INTO notifications (user_id, type, title, body, link)
    SELECT user_id,
           'admin_contract_submitted',
           'Contract Submitted',
           'A customer has uploaded a signed contract that needs your review.',
           '/admin/contracts.html'
    FROM profiles WHERE role = 'admin';
  END IF;

  RETURN NEW;
END;
$$;

-- ── 3. Payment submitted → Manager only ──────────────────────────────────────
CREATE OR REPLACE FUNCTION notify_admins_on_new_payment()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  IF NEW.payment_status = 'pending_review' THEN
    INSERT INTO notifications (user_id, type, title, body, link)
    SELECT user_id,
           'admin_payment_submitted',
           'Payment Uploaded',
           'A customer has submitted a payment that needs your review.',
           '/admin/payments.html'
    FROM profiles WHERE role = 'admin';
  END IF;
  RETURN NEW;
END;
$$;

-- ── 4. Reschedule request submitted → Manager ─────────────────────────────────
CREATE OR REPLACE FUNCTION notify_manager_on_reschedule_request()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  INSERT INTO notifications (user_id, type, title, body, link)
  SELECT user_id,
         'admin_reschedule_request',
         'Reschedule Request Submitted',
         'A customer has submitted a reschedule request for their reservation.',
         '/admin/reservations.html'
  FROM profiles WHERE role = 'admin';

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_notify_manager_reschedule_request ON reschedule_requests;
CREATE TRIGGER trg_notify_manager_reschedule_request
  AFTER INSERT ON reschedule_requests
  FOR EACH ROW EXECUTE FUNCTION notify_manager_on_reschedule_request();

-- ── 5. Reschedule request reviewed → Customer ────────────────────────────────
CREATE OR REPLACE FUNCTION notify_customer_on_reschedule_review()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_user_id uuid;
  v_title   text;
  v_body    text;
BEGIN
  IF NEW.status IS NOT DISTINCT FROM OLD.status THEN RETURN NEW; END IF;

  CASE NEW.status
    WHEN 'approved_pending_payment' THEN
      v_title := 'Reschedule Approved — Payment Required';
      v_body  := 'Your reschedule request has been approved. Please submit the reschedule fee to confirm the new date.';
    WHEN 'rejected' THEN
      v_title := 'Reschedule Request Declined';
      v_body  := 'Your reschedule request was declined. Please contact us if you have any questions.';
    ELSE RETURN NEW;
  END CASE;

  SELECT r.user_id INTO v_user_id
  FROM reservations r WHERE r.reservation_id = NEW.reservation_id;

  IF v_user_id IS NOT NULL THEN
    INSERT INTO notifications (user_id, type, title, body, link)
    VALUES (v_user_id, 'reschedule_review', v_title, v_body, '/account.html');
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_notify_customer_reschedule_review ON reschedule_requests;
CREATE TRIGGER trg_notify_customer_reschedule_review
  AFTER UPDATE ON reschedule_requests
  FOR EACH ROW EXECUTE FUNCTION notify_customer_on_reschedule_review();
