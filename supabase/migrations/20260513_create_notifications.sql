-- Notifications system — in-app + email notifications for customers and admins
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS notifications (
  id         uuid        DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id    uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  type       text        NOT NULL,
  title      text        NOT NULL,
  body       text        NOT NULL,
  link       text,
  is_read    boolean     NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS notifications_user_id_created_idx
  ON notifications (user_id, created_at DESC);

ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;

CREATE POLICY "users_read_own_notifications"
  ON notifications FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "users_mark_notifications_read"
  ON notifications FOR UPDATE
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- SECURITY DEFINER trigger functions bypass RLS (run as table owner).
-- This INSERT policy covers any future client-side admin tooling.
CREATE POLICY "admins_insert_notifications"
  ON notifications FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM profiles
      WHERE user_id = auth.uid()
        AND role IN ('admin', 'super_admin')
    )
  );

-- ── Trigger: customer notification on reservation status change ──────────────
CREATE OR REPLACE FUNCTION notify_customer_on_reservation_status()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_title text;
  v_body  text;
BEGIN
  IF NEW.status IS NOT DISTINCT FROM OLD.status THEN RETURN NEW; END IF;

  CASE NEW.status
    WHEN 'approved' THEN
      v_title := 'Reservation Approved';
      v_body  := 'Great news — your event reservation has been approved!';
    WHEN 'declined' THEN
      v_title := 'Reservation Not Approved';
      v_body  := 'Unfortunately, your reservation was not approved at this time.';
    WHEN 'for_contract_signing' THEN
      v_title := 'Contract Ready to Sign';
      v_body  := 'Your reservation is confirmed. Please upload your signed contract to proceed.';
    WHEN 'for_finalization' THEN
      v_title := 'Contract Verified';
      v_body  := 'Your signed contract has been verified. Your reservation is now moving to the finalization stage.';
    WHEN 'completed' THEN
      v_title := 'Reservation Complete';
      v_body  := 'Your event reservation is now marked complete. Thank you for choosing ELI Coffee Events!';
    WHEN 'cancelled' THEN
      v_title := 'Reservation Cancelled';
      v_body  := 'Your reservation has been cancelled. Contact us if you have any questions.';
    ELSE RETURN NEW;
  END CASE;

  INSERT INTO notifications (user_id, type, title, body, link)
  VALUES (NEW.user_id, 'reservation_status', v_title, v_body, '/account.html');

  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_notify_customer_reservation_status
  AFTER UPDATE ON reservations
  FOR EACH ROW EXECUTE FUNCTION notify_customer_on_reservation_status();

-- ── Trigger: admin notifications on reservation INSERT/UPDATE ────────────────
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
    FROM profiles WHERE role IN ('admin', 'super_admin');

  ELSIF TG_OP = 'UPDATE'
    AND NEW.status = 'cancellation_requested'
    AND (OLD.status IS DISTINCT FROM 'cancellation_requested') THEN
    INSERT INTO notifications (user_id, type, title, body, link)
    SELECT user_id,
           'admin_cancellation_request',
           'Cancellation Requested',
           'A customer has submitted a cancellation request for their reservation.',
           '/admin/reservations.html'
    FROM profiles WHERE role IN ('admin', 'super_admin');
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_notify_admins_reservation
  AFTER INSERT OR UPDATE ON reservations
  FOR EACH ROW EXECUTE FUNCTION notify_admins_on_reservation();

-- ── Trigger: notifications on contract review_status change ──────────────────
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
    FROM profiles WHERE role IN ('admin', 'super_admin');
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_notify_on_contract_review
  AFTER UPDATE ON reservation_contracts
  FOR EACH ROW EXECUTE FUNCTION notify_on_contract_review();

-- ── Trigger: admin notification on new payment submission ────────────────────
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
    FROM profiles WHERE role IN ('admin', 'super_admin');
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_notify_admins_new_payment
  AFTER INSERT ON payment
  FOR EACH ROW EXECUTE FUNCTION notify_admins_on_new_payment();

-- ── Trigger: customer notification on payment status change ──────────────────
CREATE OR REPLACE FUNCTION notify_customer_on_payment_status()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_user_id uuid;
  v_title   text;
  v_body    text;
BEGIN
  IF NEW.payment_status IS NOT DISTINCT FROM OLD.payment_status THEN RETURN NEW; END IF;

  CASE NEW.payment_status
    WHEN 'approved' THEN
      v_title := 'Payment Confirmed';
      v_body  := 'Your payment has been reviewed and confirmed.';
    WHEN 'rejected' THEN
      v_title := 'Payment Rejected';
      v_body  := 'Your payment submission was rejected. Please review the details and resubmit.';
    ELSE RETURN NEW;
  END CASE;

  SELECT r.user_id INTO v_user_id
  FROM reservations r WHERE r.reservation_id = NEW.reservation_id;

  IF v_user_id IS NOT NULL THEN
    INSERT INTO notifications (user_id, type, title, body, link)
    VALUES (v_user_id, 'payment_status', v_title, v_body, '/account.html');
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_notify_customer_payment_status
  AFTER UPDATE ON payment
  FOR EACH ROW EXECUTE FUNCTION notify_customer_on_payment_status();
