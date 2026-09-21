-- Fix NULL profiles.is_locked rows — a real data-integrity bug, not just a
-- cosmetic dashboard miscount.
--
-- 20260624_rename_roles_admin_to_manager.sql added this column as
-- `NOT NULL DEFAULT false`, but at least two live rows (both admin
-- accounts, confirmed via a direct query against the live table) have
-- is_locked = NULL rather than false — meaning that constraint isn't
-- actually enforced on the live database today (this column, like several
-- others in this project, was
-- ultimately reconciled by hand rather than purely through tracked
-- migrations — see CLAUDE.md's own note that a missing is_locked column
-- blocks ALL logins, which ruled out "column doesn't exist"; NULL values
-- slipping through is the more plausible remaining explanation).
--
-- Every `is_locked = false` comparison in this codebase silently excludes
-- a NULL row (SQL three-valued logic: NULL = false is NULL, not true) —
-- this is not just js/admin_homepage.js's "System Overview" admin count.
-- The more serious instance is protect_last_admin() (20260803_last_admin_
-- guard.sql), which counts "other active admins" the same way: with two
-- admin rows silently invisible to that count, the guard could wrongly
-- treat the one admin whose is_locked genuinely is `false` as the LAST
-- admin and block a legitimate action on their account, even though other
-- real, unlocked admins exist.
--
-- Fix: backfill every NULL to false (matching this column's own documented
-- default — a NULL is_locked was never meant to signal "locked", so this
-- doesn't change any account's actual lock state, only makes it explicit),
-- then enforce NOT NULL so it can't silently regress again.
-- ─────────────────────────────────────────────────────────────────────────────

update public.profiles
set is_locked = false
where is_locked is null;

alter table public.profiles
  alter column is_locked set default false;

alter table public.profiles
  alter column is_locked set not null;
