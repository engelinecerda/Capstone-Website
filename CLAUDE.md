# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**ELI Coffee Events** — a multi-role event reservation management system for a coffee shop. Two separate portals: a public customer site and an admin/staff management system.

**Stack:** Vanilla JS (ES6 modules), HTML, CSS — no build step, no framework.
**Backend:** Supabase (PostgreSQL + RLS + Edge Functions on Deno).
**Deployment:** Vercel (static hosting, `cleanUrls: true`). Push to git → auto-deploys.

## Frontend Commands

There is no bundler or build step. Files are served as-is.

Run locally with clean URLs (mirrors Vercel behavior, recommended):
```
npx vercel dev
```

Or use a plain static server:
```
npx serve .
```

The Supabase client is loaded via CDN (`https://cdn.jsdelivr.net/npm/@supabase/supabase-js/+esm`) so no local install is needed to run pages.

Deploy Edge Functions:
```
npx supabase functions deploy <function-name>
```

## Supabase Edge Functions

Functions live in `supabase/functions/<name>/index.ts` and run on Deno:
- `verify-contract` — Google Cloud Vision signature detection on uploaded PDFs
- `ocr-payment` — Google Cloud Vision text extraction from payment receipts
- `send-notification-email` — Resend email dispatch triggered by `notifications` table inserts
- `delete-payment-method` — admin-only hard delete of an unreferenced `payment_method` row; also destroys its Cloudinary QR asset (signed request — the admin UI's unsigned upload preset cannot delete)
- `generate-signed-contract` — renders and uploads the signed reservation contract PDF to Cloudinary, merging `{{token}}` template text (see the merge-token sync note in `js/merge_tokens.js`)
- `create-staff-account` — admin-only `auth.admin.createUser()` for a new `manager`/`staff` portal account (role allow-list enforced server-side)
- `delete-staff-account` — admin-only `auth.admin.deleteUser()` hard delete of a staff/manager account
- `delete-cloudinary-image` — signed Cloudinary `image/destroy` call for any admin-managed image (page content, business profile logo, etc.) whose upload preset is unsigned-only
- `reset-board-password` — admin-only password reset restricted to the shared kiosk `is_board_account` profile

Required secrets: `GCP_VISION_API_KEY`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `RESEND_API_KEY`, `CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET`.

## Supabase Client Setup

`js/supabase.js` exports two separate clients with different `storageKey` values:
- `customerSupabase` (`eli-customer-auth`) — all public-facing pages
- `portalSupabase` (`eli-portal-auth`) — all admin/manager/staff pages

On localhost only, both clients respect a `eli-supabase-override` localStorage key to redirect to a different Supabase project.

## Role System

The `profiles.role` column drives all access control:

| DB value   | Portal       | Access                                               |
|------------|--------------|------------------------------------------------------|
| `customer` | Public site  | Own reservations, contracts, payments                |
| `staff`    | Staff portal | Limited operational view                             |
| `manager`  | Admin portal | Reservations, contracts, payments, reviews           |
| `admin`    | Admin portal | Everything above + accounts, settings, backup, audit |

`manager` and `admin` share the same admin portal (`admin/dashboard.html`). Role-specific UI is controlled by:
- CSS classes `.manager-only` and `.super-admin-only` on nav items
- `applyRoleVisibility(role)` in `js/session_validation.js` — adds/removes `body.is-super-admin` and toggles visibility
- `super_admin_only.css` defines base display rules for those classes

## Admin Page Auth Pattern

Every admin page calls this at initialization:
```js
import { validateAdminSession } from './js/session_validation.js';
const result = await validateAdminSession();
```
`validateAdminSession` allows both `manager` and `admin` roles and auto-populates the sidebar identity. `js/admin_auth.js` also exports `verifyAdminSession`/`verifySuperAdminSession` helpers for single-role checks, but no page currently calls them — they have a different return contract than `validateAdminSession` and are not wired into the identity-population flow.

Admin-only pages (the 5 System pages under `admin/super admin/`) add a guard clause right after `validateAdminSession`, redirecting non-admin roles to the dashboard:
```js
if (result.profile.role !== 'admin') {
  window.location.replace('/admin/dashboard.html');
  return;
}
```
This is a UI-layer convenience only — the real enforcement for those pages' mutations is the admin-only RLS policies on `system_settings`, `package`/`package_category`/`package_tier`, and `profiles` (see `supabase/migrations/20260714_admin_manager_separation_of_duties.sql`).

## RLS Policy Pattern

Policies on the `profiles` table must NOT subquery `profiles` directly — that causes infinite recursion. Use the `get_my_role()` security definer function instead:

```sql
-- Correct: policies ON the profiles table
CREATE POLICY "admin read all profiles" ON public.profiles FOR SELECT
  USING (get_my_role() IN ('manager', 'admin'));

-- Correct: policies on other tables
CREATE POLICY "..." ON public.some_table FOR SELECT
  USING (EXISTS (
    SELECT 1 FROM public.profiles p
    WHERE p.user_id = auth.uid() AND p.role IN ('manager', 'admin')
  ));
```

`get_my_role()` was created in `supabase/migrations/20260624_rename_roles_admin_to_manager.sql`.

## CSS Architecture

Page-specific CSS is one-to-one with HTML pages. Some files use `@import` chains:
- `admin_contracts.css`, `admin_payments.css`, `admin_profile.css` → `@import admin_reservations.css`
- `admin_reports.css` → `@import admin_homepage.css`
- `admin_reviews.css` → `@import admin_customers.css`

`admin_sidebar.css` loads on every admin page and owns all responsive breakpoints + hamburger menu styles. It uses `!important` on `.main` margin/padding and sidebar `transform` to win against page-specific CSS loaded after it.

The hamburger button and overlay are injected dynamically by `js/admin_sidebar_counts.js` — no HTML files contain a hamburger element.

### CSS cache-busting — bump on every CSS edit

`vercel.json` caches everything under `/css/*` for a full year (`immutable`), which is only safe because every reference to a first-party stylesheet — both `<link href="/css/*.css">` tags across every HTML file and the `@import url('./*.css')` statements between CSS files — carries a `?v=1` query string. **Whenever you edit any file in `css/`, you must bump that version number everywhere** (currently a single shared `?v=1` used site-wide, not per-file), or returning visitors keep getting the old cached copy for up to a year. To bump it: find-and-replace `?v=1` → `?v=2` (next integer) across every `.html` and `.css` file in the repo.

This does **not** apply to `/js/*` — JS here is native ES modules with deep transitive `import` chains (most real logic lives in files reached only via `import ... from './x.js'` inside other JS files, never via `<script src>` directly), so versioning only the HTML entry-point `<script>` tags would leave everything they import silently uncached-busted. JS is instead capped at a 1-day cache (`vercel.json`, `/js/(.*)`) as a safer middle ground that needs no manual bumping.

## Key Shared Modules

- `js/admin_sidebar_counts.js` — runs on every admin page; injects hamburger, subscribes to Supabase Realtime for live nav badge counts
- `js/audit_logger.js` — call `logAudit(action, category, details)` to write to `audit_log` table
- `js/super_admin_inactivity.js` — call `setupInactivityLogout(role)` on admin pages; only activates for `role === 'admin'`

## Database Migrations

Schema changes go in `supabase/migrations/` as dated SQL files. They are applied manually in the Supabase SQL Editor (not via CLI) since the project targets the hosted Supabase instance directly.

## Profiles Table — Required Column

The login flow reads `is_locked` from `profiles`. If this column is missing, ALL portal logins fail with "Unable to verify account status." The column is added in `20260624_rename_roles_admin_to_manager.sql`:
```sql
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS is_locked boolean NOT NULL DEFAULT false;
```
