-- Delivery Log pagination (admin/config/notifications.html) now pages at
-- the database via .range() instead of fetching everything and slicing in
-- the browser (js/admin_notifications_config.js's loadLog()). That query is:
--
--   select ... from notifications
--   where trigger_code is not null
--     [and trigger_code = :trigger]   -- optional filter
--     [and status = :status]          -- optional filter
--   order by created_at desc
--   range(from, to)
--
-- The only existing index (notifications_user_id_created_idx, from
-- 20260513_create_notifications.sql) is keyed on user_id first, which is
-- never part of this query — useless for it. Two additions:
--
-- 1. A partial index matching the base case (every log row, unfiltered)
--    exactly: same predicate, same sort column, so both the WHERE and the
--    ORDER BY/range() are satisfied by a single index scan with no sort
--    step, regardless of table size.
-- 2. Plain indexes on trigger_code/status so the optional filters can be
--    combined with the above via a bitmap scan instead of a sequential
--    scan once one of them narrows the result set.
--
-- Count for "showing X of Z" uses count: 'exact' (a real SELECT count(*)
-- against the same filtered predicate) — perfectly fine at this project's
-- scale; if the table ever grows large enough for that count to become the
-- slow part, swap it for Postgres's estimated relation row count (or a
-- capped count(*) ... limit N+1 treated as "N+") instead of an index change.
-- ─────────────────────────────────────────────────────────────────────────────

create index if not exists notifications_log_created_idx
  on public.notifications (created_at desc)
  where trigger_code is not null;

create index if not exists notifications_trigger_code_idx
  on public.notifications (trigger_code);

create index if not exists notifications_status_idx
  on public.notifications (status);
