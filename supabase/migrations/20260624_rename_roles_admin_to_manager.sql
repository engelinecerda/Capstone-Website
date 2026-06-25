-- Role rename: 'admin' → 'manager', 'super_admin' → 'admin'
-- Aligns DB values with login dropdown (value="manager" / value="admin")
-- Run once in Supabase SQL Editor.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 0. Add missing is_locked column (login checks this; blocks ALL logins if absent) ──
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS is_locked boolean NOT NULL DEFAULT false;

-- ── 1. Rename role values in profiles ────────────────────────────────────────
-- Order matters: rename admin→manager first so the second UPDATE doesn't
-- accidentally catch rows already renamed by the first.
UPDATE public.profiles SET role = 'manager' WHERE role = 'admin';
UPDATE public.profiles SET role = 'admin'   WHERE role = 'super_admin';

-- ── 2. notifications: admins_insert_notifications ────────────────────────────
DROP POLICY IF EXISTS "admins_insert_notifications" ON public.notifications;
CREATE POLICY "admins_insert_notifications"
  ON public.notifications FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM profiles
      WHERE user_id = auth.uid()
        AND role IN ('manager', 'admin')
    )
  );

-- ── 3. system_settings: admin_write_system_settings ──────────────────────────
DROP POLICY IF EXISTS "admin_write_system_settings" ON public.system_settings;
CREATE POLICY "admin_write_system_settings"
  ON public.system_settings FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM profiles
      WHERE user_id = auth.uid()
        AND role IN ('manager', 'admin')
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM profiles
      WHERE user_id = auth.uid()
        AND role IN ('manager', 'admin')
    )
  );

-- ── 4. profiles: admin read all profiles ─────────────────────────────────────
-- Uses a SECURITY DEFINER function to avoid infinite recursion
-- (a policy on profiles cannot safely subquery profiles without bypassing RLS)
CREATE OR REPLACE FUNCTION public.get_my_role()
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT role FROM public.profiles WHERE user_id = auth.uid()
$$;

DROP POLICY IF EXISTS "admin read all profiles" ON public.profiles;
CREATE POLICY "admin read all profiles"
  ON public.profiles FOR SELECT
  USING (
    get_my_role() IN ('manager', 'admin')
  );

-- ── 5. reservations: admin read all ──────────────────────────────────────────
DROP POLICY IF EXISTS "admin read all reservations" ON public.reservations;
CREATE POLICY "admin read all reservations"
  ON public.reservations FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.user_id = auth.uid()
        AND p.role IN ('manager', 'admin')
    )
  );

-- ── 6. reservations: admin manage ────────────────────────────────────────────
DROP POLICY IF EXISTS "admin manage reservations" ON public.reservations;
CREATE POLICY "admin manage reservations"
  ON public.reservations FOR UPDATE
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.user_id = auth.uid()
        AND p.role = 'manager'
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.user_id = auth.uid()
        AND p.role = 'manager'
    )
  );

-- ── 7. reservation_status: admin read all ────────────────────────────────────
DROP POLICY IF EXISTS "admin read all reservation status history" ON public.reservation_status;
CREATE POLICY "admin read all reservation status history"
  ON public.reservation_status FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.user_id = auth.uid()
        AND p.role IN ('manager', 'admin')
    )
  );

-- ── 8. reservation_status: admin insert ──────────────────────────────────────
DROP POLICY IF EXISTS "admin insert reservation status history" ON public.reservation_status;
CREATE POLICY "admin insert reservation status history"
  ON public.reservation_status FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.user_id = auth.uid()
        AND p.role = 'manager'
    )
  );

-- ── 9. reservation_cancellations: admin read all ──────────────────────────────
DROP POLICY IF EXISTS "admin read all reservation cancellations" ON public.reservation_cancellations;
CREATE POLICY "admin read all reservation cancellations"
  ON public.reservation_cancellations FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.user_id = auth.uid()
        AND p.role IN ('manager', 'admin')
    )
  );

-- ── 10. reviews: admin read all ───────────────────────────────────────────────
DROP POLICY IF EXISTS "admin read all reviews" ON public.reviews;
CREATE POLICY "admin read all reviews"
  ON public.reviews FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.user_id = auth.uid()
        AND p.role IN ('manager', 'admin')
    )
  );

-- ── 11. Trigger functions: operational events go to Manager (role='manager') ──

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
    FROM profiles WHERE role = 'manager';

  ELSIF TG_OP = 'UPDATE'
    AND NEW.status = 'cancellation_requested'
    AND (OLD.status IS DISTINCT FROM 'cancellation_requested') THEN
    INSERT INTO notifications (user_id, type, title, body, link)
    SELECT user_id,
           'admin_cancellation_request',
           'Cancellation Requested',
           'A customer has submitted a cancellation request for their reservation.',
           '/admin/reservations.html'
    FROM profiles WHERE role = 'manager';
  END IF;

  RETURN NEW;
END;
$$;

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
    FROM profiles WHERE role = 'manager';
  END IF;

  RETURN NEW;
END;
$$;

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
    FROM profiles WHERE role = 'manager';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION notify_manager_on_reschedule_request()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  INSERT INTO notifications (user_id, type, title, body, link)
  SELECT user_id,
         'admin_reschedule_request',
         'Reschedule Request Submitted',
         'A customer has submitted a reschedule request for their reservation.',
         '/admin/reservations.html'
  FROM profiles WHERE role = 'manager';

  RETURN NEW;
END;
$$;
