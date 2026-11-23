-- bane:batched
-- Backfill inbox_state.unread in bounded pages while mail arrives and flags change.
-- Locks each page in statement 1 and counts on a post-lock READ COMMITTED snapshot in statement 2.
-- Idempotent and safe to re-run.
SELECT inbox_unread_backfill_page($1) AS cursor;
