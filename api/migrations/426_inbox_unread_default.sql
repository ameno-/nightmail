SET LOCAL lock_timeout='2s';

-- Existing rows were backfilled in 410; default new bare inserts to 0 while keeping inbox_view's coalesce fallback.
ALTER TABLE inbox_state ALTER COLUMN unread SET DEFAULT 0;
