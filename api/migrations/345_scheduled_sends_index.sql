-- bane:no-transaction
CREATE INDEX CONCURRENTLY IF NOT EXISTS sending_emails_scheduled_page ON sending_emails(workspace_id,created_at DESC,id DESC) WHERE status='scheduled';
