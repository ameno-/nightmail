-- bane:no-transaction
-- The inbox thread list of a workspace session or unrestricted key filters mailbox_threads by workspace alone and groups by thread.
CREATE INDEX CONCURRENTLY IF NOT EXISTS mailbox_threads_workspace ON mailbox_threads(workspace_id,thread_id);
-- Event polls and the latest cursor read one workspace's events in seq order, with no address filter or IS NOT NULL.
CREATE INDEX CONCURRENTLY IF NOT EXISTS mailbox_events_cursor ON mailbox_events(workspace_id,seq);
-- Same columns as mailbox_events_prune (095), which the prune keeps using.
DROP INDEX CONCURRENTLY IF EXISTS mailbox_events_created;
