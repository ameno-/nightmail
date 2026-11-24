-- bane:no-transaction
-- Partial index for mail-gateway IMAP SEARCH unkept-append check (typically empty, ~8 kB).
CREATE INDEX CONCURRENTLY IF NOT EXISTS mail_messages_unkept_append ON mail_messages (workspace_id, id) WHERE verdicts->>'origin' = 'client-append' AND NOT (verdicts ? 'fields');
