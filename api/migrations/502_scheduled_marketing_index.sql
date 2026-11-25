-- bane:no-transaction
-- The ramp's 24-hour budget for scheduled marketing (ramp_refusal, migration 501): a workspace's marketing scheduled for
-- within 24 hours either side of a new one's time is counted from this index alone. Only scheduled marketing that isn't a
-- campaign's is in it, so it stays small, and no other send writes to it.
CREATE INDEX CONCURRENTLY IF NOT EXISTS sending_emails_scheduled_marketing ON sending_emails (workspace_id, scheduled_at) WHERE status='scheduled' AND campaign_id IS NULL AND (snapshot->>'kind')='marketing';
