SET LOCAL lock_timeout = '2s';
-- Glass's week of support (src/support-inbox.ts supportWeek): the conversations started in the last 7 days, newest
-- first, read through this index instead of the whole table.
CREATE INDEX IF NOT EXISTS support_conversations_created ON support_conversations (created_at);
