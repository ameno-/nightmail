-- bane:no-transaction
-- Supports oldest-first bounded retention on mail_unrouted without sorting the table.
CREATE INDEX CONCURRENTLY IF NOT EXISTS mail_unrouted_created_at ON mail_unrouted (created_at);
