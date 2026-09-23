-- Remove the Inquiries feature entirely, per the adviser's request: with no
-- chat/reply capability, an inquiry is just a duplicate of information the
-- customer can already see directly on the package/reservation pages, so
-- the whole lead-capture form (customer + admin sides) and its companion
-- "Referral Sources" lookup (which existed solely to feed this form's "How
-- did you hear about us?" dropdown — confirmed unused anywhere else in the
-- codebase) are being dropped together.
--
-- Reverses supabase/migrations/20261013_inquiries_feature.sql in full,
-- plus the follow-up check constraints added in
-- 20261017_text_field_length_limits.sql (those live on public.inquiries
-- itself and disappear automatically with `drop table`).
--
-- Safe to drop outright: confirmed nothing else in the schema holds a FK
-- pointing AT inquiries or referral_sources — inquiries.converted_
-- reservation_id points the other way (inquiries -> reservations), and
-- reservations itself has no column referencing inquiries.
--
-- Historical rows already sitting in public.notifications (type
-- 'admin_new_inquiry', or dispatched with trigger_code = 'inquiry_received')
-- are kept as normal notification history — their title/body/link were
-- already fully rendered at send time, so they stay meaningful without the
-- catalogue row behind them. public.notifications.trigger_code is a
-- nullable FK to notification_trigger(code) (20260808_notification_
-- config.sql) with no ON DELETE clause, so it must be nulled out on any
-- matching rows before the notification_trigger row itself can be deleted
-- — confirmed necessary: a first run of this migration failed with
-- "update or delete on table notification_trigger violates foreign key
-- constraint notifications_trigger_code_fkey" for exactly this reason.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1. Notification catalogue rows (20261013's "3. Notifications") ─────────
update public.notifications set trigger_code = null where trigger_code = 'inquiry_received';
delete from public.notification_template where trigger_code = 'inquiry_received';
delete from public.notification_trigger where code = 'inquiry_received';

-- ── 2. inquiries — table first (cascades to its own triggers automatically,
--    which also sidesteps a Postgres quirk: `drop trigger if exists x on
--    public.inquiries` still eagerly resolves the table name and errors if
--    the table itself doesn't exist, even with IF EXISTS on the trigger —
--    hit exactly that on a second run here, "relation public.inquiries
--    does not exist"), then the now-unreferenced functions. ────────────────
drop table if exists public.inquiries;
drop function if exists public.notify_on_inquiry_submitted();
drop function if exists public.set_inquiries_updated_at();

-- ── 3. referral_sources — companion lookup, unused now that inquiries is gone ──
drop table if exists public.referral_sources;
