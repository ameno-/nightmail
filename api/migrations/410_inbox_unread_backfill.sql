-- bane:batched
-- Backfill inbox_state.unread in bounded pages while mail arrives and flags change.
-- Locks each page of inbox_state FOR UPDATE in inbox_id order (matching ingest), so concurrent
-- writers wait for the page and apply deltas on top of the exact recounted value.
-- Safe to re-run: always reconciles each page to the exact count.
WITH page AS MATERIALIZED (
  SELECT inbox_id FROM inbox_state WHERE inbox_id > coalesce($1, '') ORDER BY inbox_id LIMIT 50 FOR UPDATE
),
counts AS (
  SELECT p.inbox_id,
         (SELECT count(*)::int FROM mailbox_messages m WHERE m.mailbox_id = p.inbox_id AND NOT m.read AND m.held_reason IS NULL) AS unread
  FROM page p
),
updated AS (
  UPDATE inbox_state s SET unread = c.unread FROM counts c
  WHERE s.inbox_id = c.inbox_id AND s.unread IS DISTINCT FROM c.unread
)
SELECT max(inbox_id) AS cursor FROM page;
