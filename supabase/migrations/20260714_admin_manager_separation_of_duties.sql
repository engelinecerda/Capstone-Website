-- Separation of duties (Model B): Admin owns system configuration exclusively;
-- Manager owns all operational mutations. Admin keeps read-only visibility into
-- operations via existing SELECT policies (unchanged by this migration).
--
-- Caveat: this is enforced at the application and database-policy layer only.
-- A super admin with direct database or service-role access can always bypass
-- RLS — that is an accepted limitation of Postgres RLS, not something this
-- migration can close.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 1. reservations / payment / reservation_contracts ────────────────────────
-- Already manager-only UPDATE as of 20260624_rename_roles_admin_to_manager.sql,
-- 20260713_fix_payment_rls.sql, and 20260713_fix_reservation_contracts_rls.sql.
-- No changes here — verified, not re-touched.

-- ── 2. system_settings: admin-only write (was manager OR admin) ─────────────
-- "public_read_system_settings" (20260513_create_system_settings.sql) already
-- grants open SELECT — left untouched so the booking flow keeps reading
-- booking hours / cancellation policy values.
DROP POLICY IF EXISTS "admin_write_system_settings" ON public.system_settings;
CREATE POLICY "admin_write_system_settings"
  ON public.system_settings FOR ALL
  USING (get_my_role() = 'admin')
  WITH CHECK (get_my_role() = 'admin');

-- ── 3. package / package_category / package_tier: admin-only write ──────────
-- SELECT policies (public active-only + admin/manager/staff read-all) are left
-- untouched — Manager and Staff keep read-only package visibility.
DROP POLICY IF EXISTS "Admin manage packages" ON public.package;
CREATE POLICY "Admin manage packages" ON public.package
  FOR ALL
  USING (get_my_role() = 'admin')
  WITH CHECK (get_my_role() = 'admin');

DROP POLICY IF EXISTS "Admin manage categories" ON public.package_category;
CREATE POLICY "Admin manage categories" ON public.package_category
  FOR ALL
  USING (get_my_role() = 'admin')
  WITH CHECK (get_my_role() = 'admin');

DROP POLICY IF EXISTS "Admin manage tiers" ON public.package_tier;
CREATE POLICY "Admin manage tiers" ON public.package_tier
  FOR ALL
  USING (get_my_role() = 'admin')
  WITH CHECK (get_my_role() = 'admin');

-- ── 4. profiles: admin-only write on other users' rows ───────────────────────
-- Previously there was NO policy letting anyone but the row owner write their
-- own profile ("insert own profile" / "update own profile",
-- 20260401_create_profiles.sql) — User Management could not actually persist
-- account creation, role changes, or lock/unlock without this.
DROP POLICY IF EXISTS "admin manage profiles" ON public.profiles;
CREATE POLICY "admin manage profiles"
  ON public.profiles FOR UPDATE
  USING (get_my_role() = 'admin')
  WITH CHECK (get_my_role() = 'admin');

DROP POLICY IF EXISTS "admin insert profiles" ON public.profiles;
CREATE POLICY "admin insert profiles"
  ON public.profiles FOR INSERT
  WITH CHECK (get_my_role() = 'admin');
