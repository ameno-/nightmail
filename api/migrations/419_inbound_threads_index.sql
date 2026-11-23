-- bane:no-transaction
-- Workspace-wide inbound thread pagination without full-table GROUP BY / sort, and inbox-kind page index.
CREATE INDEX CONCURRENTLY IF NOT EXISTS mailbox_threads_workspace_page ON mailbox_threads (workspace_id, last_message_at DESC, thread_id DESC);
CREATE INDEX CONCURRENTLY IF NOT EXISTS mailboxes_inbox_page ON mailboxes (workspace_id, id) WHERE kind = 'inbox';
