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
- `validate-receipt` — pre-submission receipt check (`20261130_receipt_validation.sql`). Called after the proof is uploaded and before the `payment` row is inserted. Gemini only READS the receipt (amount, reference, date, provider, receiver name, receiver account tail, transaction status); every pass/mismatch decision is plain code in `_shared/receipt_compare.ts` (unit tests: `node --experimental-strip-types supabase/functions/_shared/receipt_compare_test.ts`). The expected receiver is loaded server-side from `payment_method` (`account_name`, `receipt_name_aliases`, `account_number`/`phone_number`) and never comes from the browser. Verdicts: `pass`, `needs_review` (unreadable/uncertain, never blocks) and `mismatch` (confident mismatch). The result is stored in `receipt_checks` (service-role write only) and the `trg_zz_payment_receipt_check` trigger on `payment` looks for it on every customer-submitted insert. Mode lives in `system_settings.receipt_validation_mode`: `off`, `warn` (default: records `payment.receipt_check_status`, never blocks) or `enforce` (rejects mismatches, missing checks and reused reference numbers). Requires a signed-in user; only our own Cloudinary payment uploads are fetched. Secrets: `GEMINI_API_KEY`; optional `GEMINI_MODEL`, `RECEIPT_CLOUDINARY_CLOUD`. Separate from `ocr-payment`, which still fills the manager's OCR panel after submission. **Customer page (`js/customer_payments.js` + `js/payment.js`):** `submitCustomerPayment()` uploads the proof, calls `validate-receipt` (`runReceiptCheck()`, which never throws: a failed call just means no stored check and the trigger decides), and only then inserts the `payment` row. A response with `can_submit: false` (enforce mode + mismatch) throws `ReceiptCheckError`; `handleSubmitPayment()` catches it, keeps every form field and the attached receipt, and shows the per-field checklist (`renderReceiptCheckPanel()`) with a "Replace receipt" button. The submit button shows Uploading / Checking your receipt / Submitting stages (`state.submitStage`). Server messages are rendered through `escapeHtml` because part of them is text read off the customer's image. **Admin side:** `js/admin_payments.js` loads each page's `payment.receipt_check_status` + `receipt_checks` row (`fetchReceiptChecks()`, best-effort: a failure just hides the info) and shows a status pill in the table plus a "Receipt check" panel in the review modal (per-field results, receiver name read, mode note). Payment Settings (`admin/config/payment-options.html`, `js/admin_payment_options.js`) has an "Other names on receipts" field on bank/e-wallet methods (`payment_method.receipt_name_aliases`, up to 10 names via `parseReceiptAliases()`) and a Receipt Validation card that writes `system_settings.receipt_validation_mode` (`off`/`warn`/`enforce`, plain string, audit-logged).
- `ocr-payment` — Gemini Flash (vision) assists payment-proof field extraction (amount/reference/date), replacing rigid text parsing to handle receipt layout variation; every payment is still verified by a manager against the original image. Extraction is advisory with a manual-review fallback on any failure (timeout, quota, safety block, malformed output) — never an automated approval mechanism. Provider is swappable by editing the `extractPaymentFields()` wrapper only.
- `verify-id-signature` — "Re-upload my ID" retry for a contract left pending by a failed ID check (uses a photo sent in the request, or `use_saved_id: true` for the ID on the customer's profile). Requires a signed-in user who owns the reservation; re-reads the signature saved on the contract and compares it with the new ID photo (Gemini Flash vision, shared code in `supabase/functions/_shared/id_signature_check.ts`). Returns `verdict`, `verified`, `attempts_left`. The ID is never logged. A service failure is not a verdict and is not counted as an attempt.
- **Valid ID on the profile** — the customer's ID is saved once on **My Profile** (`account.html` "Valid ID" card, `js/account.js`) and reused for every contract. Storage: private Supabase bucket `customer-ids`, one object per customer at `<user_id>/valid-id.jpg`; `profiles.valid_id_uploaded_at` is the "has an ID on file" flag (`20261128_profile_valid_id.sql`). The customer can replace or remove it any time. Owner-only storage policies; no manager/admin read policy. Edge Functions build the path from the verified caller id (`loadSavedIdForUser()` in `_shared/id_signature_check.ts`) and never trust a browser-supplied path. All browser code goes through `js/valid_id.js` (`saveValidId`, `removeValidId`, `fetchValidIdStatus`, `resizeIdImage`…). On the reservation form (`js/reservations.js`): ID on file → the upload is hidden and `use_saved_id: true` is sent; no ID → the customer uploads there, it is saved to My Profile, and the photo is sent with the submit. `reservation-details` retry modal (`js/id_signature_retry.js`) re-checks the saved ID or saves a replacement photo.
- **ID signature check flow** — `submitDone()` in `js/reservations.js` sends the resized ID photo (or `use_saved_id`) with the e-signature to `generate-signed-contract`, which always creates the reservation's contract and then compares the two signatures: match → `review_status = 'verified'`; otherwise the contract stays `pending_review`, the customer gets an in-app + email notification ("Signature Check Needed"), and `reservation-details` shows a prompt to re-upload the ID (`verify-id-signature`) or sign again (`generate-signed-contract` with `resign: true`, which uses the saved ID — or a photo chosen in the modal when none is saved — and swaps the PDF via the service-role-only `replace_pending_contract()` RPC). State lives in `reservation_contracts.id_check_status` / `id_check_attempts` (`20261127_id_signature_check_after_submit.sql`). Automatic checks are capped at `MAX_ID_CHECK_ATTEMPTS` (5), then staff verify manually. `verify-contract` skips any contract whose `id_check_status` is set. Switch off with `ID_VERIFICATION_ENABLED` in `js/reservations.js`; tune strictness with `MATCH_MIN_CONFIDENCE` in the shared module. Functions importing `_shared/` must be deployed with the CLI.
- `calculate-transport-fee` — prices the offsite transport fee for a venue pin (real driving distance from OpenRouteService, straight-line × road factor fallback). Distance is measured only from active branches flagged `business_location.transport_origin = true` that have a map pin (`20261129_transport_fee_start_point.sql`); a branch that is shown to customers but not flagged is never used. Admins set the flag with the "Use as a transport fee starting point" checkbox in Business profile → Edit branch (needs a pin). `js/transport_fee.js` (`transportOrigins()`) mirrors the rule for the booking-form fallback and the Payment Settings example. Payment Settings refuses to switch the fee on while no starting point exists. Secret: `ORS_API_KEY`. Deploy order: migration → edge function → site.
- `send-notification-email` — Resend email dispatch triggered by `notifications` table inserts
- `delete-payment-method` — admin-only hard delete of an unreferenced `payment_method` row; also destroys its Cloudinary QR asset (signed request — the admin UI's unsigned upload preset cannot delete)
- `generate-signed-contract` — renders and uploads the signed reservation contract PDF to Cloudinary, merging `{{token}}` template text (see the merge-token sync note in `js/merge_tokens.js`)
- `create-staff-account` — admin-only. `admin`/`manager` are invited by email (`inviteUserByEmail`). `staff` is the single shared board account: refused (409) if any staff/board profile already exists, created with `createUser()` and a generated password returned once to the admin (no email), and flagged `is_board_account`. A unique index (`20261113_single_board_account.sql`) enforces the limit of one in the database too
- `delete-staff-account` — admin-only `auth.admin.deleteUser()` hard delete of a staff/manager account
- `delete-cloudinary-image` — signed Cloudinary `image/destroy` call for any admin-managed image (page content, business profile logo, etc.) whose upload preset is unsigned-only
- `reset-board-password` — admin-only password reset restricted to the shared kiosk `is_board_account` profile

Required secrets: `GCP_VISION_API_KEY`, `GEMINI_API_KEY`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `RESEND_API_KEY`, `CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET`. Optional: `GEMINI_MODEL` (defaults to the current Flash model — see `ocr-payment/index.ts` — override without a redeploy if Google renames/retires it).

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
| `manager`  | Admin portal | Reservations, contracts, payments, reviews (moderation is manager-only) |
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
  
- `js/admin_sidebar_counts.js` — runs on every admin page; injects hamburger, fills the nav badges and the maintenance strip from one `get_admin_nav_counts()` RPC call (cached ~45 s in sessionStorage, made after the page finishes loading; falls back to separate queries if the RPC is missing)
- `js/table_sort.js` — sortable table headers for the admin list pages. A header opts in with `data-sort-key` (and `data-sort-first="desc"` for date columns); `initTableSort(table, { defaultSort, onChange })` turns its text into a button with one arrow, cycling first direction → opposite → back to the page default. Server-paginated pages (reservations, payments, contracts, customers) send `getRpcParams()` (`p_sort_key`/`p_sort_dir`) to their `get_admin_*_page()` RPC via `rpcWithSort()` so the whole result is sorted in the database (`20261116_sortable_admin_lists.sql`); pages that hold every row (accounts, reports) use `sortRows()`. Styles live in `css/manager-theme.css`.
- `js/auto_refresh.js` — `initAutoRefresh(fn, { pollMs })` re-runs a page's loader on tab focus/visibility/bfcache restore and on a slow timer (default 1 min, `AUTO_REFRESH_POLL_MS`; `pollMs: 0` = no timer; reservations/payments/customers/reviews/roster/calendar use 2 min, accounts 5 min; dashboard, contracts, reports, notifications, the manager bell and the announcement banner use the 1-min default). It skips every automatic refresh while the service-issue notice is showing (`window.__eliSupabaseDown`, set by `js/supabase_health_notice.js`, which also fires `eli:supabase-down` / `eli:supabase-up`) and refreshes once on recovery. A loader that fails quietly should `return false` so the "Updated" time is not advanced. The returned function also has `.refresh()`, `.getLastUpdated()`, `.isRefreshing()`, `.subscribe(fn)`.
- `js/refresh_status.js` — `mountRefreshStatus(autoRefresh)` adds the Refresh button and "Updated 2:41 PM" label under the page subtitle (Reservations, Contracts, Payments, Customers, Reviews). Styles live in `css/admin_sidebar.css`.
- `js/footer_content.js` — public footer data (contact, social links, locations, services) is cached in localStorage (`eli-footer-cache-v1`) for 5 minutes, each part separately; an expired copy is still shown if Supabase fails or is reported down. Business Profile / Page Content clear the admin's own copy when leaving (`js/footer_cache.js`). Edits can take up to 5 min to reach other visitors.
- `js/load_exceljs.js` — `loadExcelJS()` downloads ExcelJS (pinned 4.4.0) on the first export only (Reports, Audit Trail); do not add it back as a `<script>` tag.
- `js/contract_breakdown.js` — the contract's **Price Breakdown** and **Additional Requests** sections (system-added, not template text). `buildBreakdownRows()` itemises package, add-on, additional guests, removed inclusions, discount, subtotal, service charge, transport fee and total, in the booking order of operations; `buildRequestRows()` lists the customer's notes and custom requests (unpriced at signing, charged only if the customer accepts a quote, so outside the Total Amount). Used by the Review & Sign preview (`js/reservations.js`) and the admin Contract Template preview. The signed PDF (`generate-signed-contract`, Deno) mirrors the same rows in `buildBreakdownRows()`/`drawPriceBreakdown()` from the figures frozen on the reservation, with the package line as the remainder so rows always add up to `total_price`; keep both in sync. Custom-request titles are sent with the contract call (they are saved after it) and read from `reservation_custom_requests` on a re-sign.
- `js/audit_logger.js` — call `logAudit(action, category, details)` to write to `audit_log` table
- `js/super_admin_inactivity.js` — call `setupInactivityLogout(role)` on admin pages; only activates for `role === 'admin'`

## Anonymous reviews

A customer can tick "Review anonymously" when submitting a review, and can flip it later with the **Edit** button on their own cards on `reviews.html` (only anonymity is editable — rating and comment stay as written). Backed by `supabase/migrations/20261105_anonymous_reviews.sql`:
- `reviews.is_anonymous boolean not null default false`.
- `get_public_reviews()` (security definer, callable by `anon`) is what the public page loads. For an anonymous review it returns `first_name`/`last_name` as NULL and never returns `user_id`, so the name is stripped in the database, not just hidden in JS. It also returns `is_mine` (the caller's own rows) which drives the Edit button.
- `set_review_anonymity(review_id, bool)` (security definer, `authenticated`) is the only way a customer can modify a review — no general UPDATE policy was added to `public.reviews`.
- Admin/manager still see the real name in `admin/reviews.html` with an "Anonymous publicly" pill (`get_admin_reviews_page` now also returns `is_anonymous`).
- `js/reviews.js` falls back to the old direct query only when `get_public_reviews` is missing (PGRST202/42883, i.e. migration not applied yet). Delete `fetchReviewsLegacy()` once the migration is live everywhere.
- Check the live DB has no broad public SELECT policy on `reviews`/`profiles` names that bypasses the function (query in the migration header).

## Database Migrations

Schema changes go in `supabase/migrations/` as dated SQL files. They are applied manually in the Supabase SQL Editor (not via CLI) since the project targets the hosted Supabase instance directly.

## Overdue auto-cancel and the cancellation fee

`auto_cancel_overdue_reservations()` (hourly pg_cron; latest definition `20261201_no_cancellation_fee_when_nothing_paid.sql`) cancels approved reservations past their payment due date + grace period. If the reservation has **no approved payment of any type** it is cancelled normally with **no `cancellation_fee` row**; if anything was paid, the fee row is created as before. Because the customer pages treat "cancelled with no fee row" as "fee owed", `isCancellationFeeWaived()` in `js/reservation_shared.js` recognises the fee-free case (`cancellation_reason = 'auto_cancelled_overdue'` and no fee row) and `isCancellationFeeOwed()` returns false for it. Any new screen that reads a reservation must select `cancellation_reason` for that to work.

## Profiles Table — Required Column

The login flow reads `is_locked` from `profiles`. If this column is missing, ALL portal logins fail with "Unable to verify account status." The column is added in `20260624_rename_roles_admin_to_manager.sql`:
```sql
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS is_locked boolean NOT NULL DEFAULT false;
```

## Temporary testing-phase notice (remove after testing)

`js/system_notice.js` shows a closable "System Notice" popup once per browser session plus a small bottom-left pill, on every root-level public page. It is hardcoded, self-contained (styles injected by the script), and intentionally not admin-configurable. To remove it: delete `js/system_notice.js` and the two lines tagged `SYSTEM-NOTICE` (a comment + a `<script>`) near the end of `<body>` in each root `.html` file (`grep -rl "SYSTEM-NOTICE" --include=*.html .`).

## Board kiosk polling (`js/board.js`)

The board stays open all day with the screen kept awake (wake lock), so it never pauses like a normal hidden tab. To keep it from loading Supabase, `board.js` follows these rules (constants at the top of the file):

- One schedule refresh per `SCHEDULE_REFRESH_MS` (60 s). Each refresh is two requests: `board_reservations_view` + `reservation_staff_assignments`. A new or changed reservation can take up to about a minute to appear.
- The next refresh is scheduled only after the previous one finishes (a `setTimeout` chain, not `setInterval`), so slow responses never overlap.
- After a failed refresh the gap doubles (60 s → 120 s → 240 s, capped at `SCHEDULE_REFRESH_MAX_MS` = 5 min) with ±10% jitter, and returns to 60 s after one success.
- The full role check (`verifyPortalSession`, which queries `profiles`) runs on load and then every `SESSION_RECHECK_MS` (10 min). Every refresh in between only reads the locally stored session (no request); if it is gone, the signed-out state is shown.
- A hidden tab skips refreshes; focus / visibility events trigger one refresh (events within `REFRESH_MIN_GAP_MS` share it).
- The footer text ("refreshes every N seconds") reads `SCHEDULE_REFRESH_MS`, so changing the constant updates it.

## Supabase health notice (permanent)

`js/supabase_health_notice.js` watches whether the site's own Supabase project is answering and, after 3 failed checks in a row, shows a "Service Notice" popup (same look and behaviour as the System Notice: backdrop, page scroll locked, Esc/backdrop/button to close) once per outage. Closing it leaves a small bottom-right pill that reopens it; both remove themselves when Supabase answers again. If the System Notice or Beta Testing Guide popup is open when the outage is detected, this popup waits until it is closed instead of stacking on top. If an outage comes back within 10 minutes of one the visitor had already seen and closed, it returns as the pill only (no second popup); after 10 minutes of stability the next outage gets the full popup again (`RELAPSE_WINDOW_MS`). A check is one small read of the public `business_contact` table; no answer within 8 seconds, a network error, or a 5xx counts as a failure, while a slow-but-successful answer is healthy. A visitor who is offline is never counted. The timings (timeout, number of checks, intervals) are constants at the top of the file. It is a separate file from `system_notice.js` so it survives the testing-phase removal. Loaded on every root-level public page via the two lines tagged `SUPABASE-HEALTH` near the end of `<body>` (`grep -rl "SUPABASE-HEALTH" --include=*.html .`); admin and board pages do not load it. Its Supabase URL/key are copied from `js/supabase.js` and must be kept in sync.