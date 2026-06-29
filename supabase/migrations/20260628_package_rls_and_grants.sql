-- Grant UPDATE/INSERT/DELETE on package tables to authenticated users so
-- admin/manager archive operations actually persist in the database.
-- Without these grants, UPDATE returns 0 rows silently with no error.

GRANT SELECT, INSERT, UPDATE, DELETE ON public.package          TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.package_category TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.package_tier     TO authenticated;

-- ── RLS: package ──────────────────────────────────────────────────────────────
ALTER TABLE public.package ENABLE ROW LEVEL SECURITY;

-- Anyone (including unauthenticated customers) can read active packages.
DROP POLICY IF EXISTS "Public read active packages" ON public.package;
CREATE POLICY "Public read active packages" ON public.package
  FOR SELECT
  USING (is_active = true);

-- Admin and manager can read ALL packages (including archived).
DROP POLICY IF EXISTS "Admin read all packages" ON public.package;
CREATE POLICY "Admin read all packages" ON public.package
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.user_id = auth.uid()
        AND p.role IN ('admin', 'manager', 'staff')
    )
  );

-- Admin and manager can insert, update, delete packages.
DROP POLICY IF EXISTS "Admin manage packages" ON public.package;
CREATE POLICY "Admin manage packages" ON public.package
  FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.user_id = auth.uid()
        AND p.role IN ('admin', 'manager')
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.user_id = auth.uid()
        AND p.role IN ('admin', 'manager')
    )
  );

-- ── RLS: package_category ─────────────────────────────────────────────────────
ALTER TABLE public.package_category ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Public read active categories" ON public.package_category;
CREATE POLICY "Public read active categories" ON public.package_category
  FOR SELECT
  USING (is_active = true);

DROP POLICY IF EXISTS "Admin read all categories" ON public.package_category;
CREATE POLICY "Admin read all categories" ON public.package_category
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.user_id = auth.uid()
        AND p.role IN ('admin', 'manager', 'staff')
    )
  );

DROP POLICY IF EXISTS "Admin manage categories" ON public.package_category;
CREATE POLICY "Admin manage categories" ON public.package_category
  FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.user_id = auth.uid()
        AND p.role IN ('admin', 'manager')
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.user_id = auth.uid()
        AND p.role IN ('admin', 'manager')
    )
  );

-- ── RLS: package_tier ─────────────────────────────────────────────────────────
ALTER TABLE public.package_tier ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Public read active tiers" ON public.package_tier;
CREATE POLICY "Public read active tiers" ON public.package_tier
  FOR SELECT
  USING (is_active = true);

DROP POLICY IF EXISTS "Admin read all tiers" ON public.package_tier;
CREATE POLICY "Admin read all tiers" ON public.package_tier
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.user_id = auth.uid()
        AND p.role IN ('admin', 'manager', 'staff')
    )
  );

DROP POLICY IF EXISTS "Admin manage tiers" ON public.package_tier;
CREATE POLICY "Admin manage tiers" ON public.package_tier
  FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.user_id = auth.uid()
        AND p.role IN ('admin', 'manager')
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.user_id = auth.uid()
        AND p.role IN ('admin', 'manager')
    )
  );
