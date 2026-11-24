-- bane:no-transaction
-- Partial index covering only queued transactional emails so dispatcher leaseDue discovers
-- transactional owners immediately ahead of ownerCursor and large marketing queues.
CREATE INDEX CONCURRENTLY IF NOT EXISTS sending_emails_tx_due ON sending_emails (region, created_at, id) WHERE status = 'queued' AND (snapshot->>'kind') = 'transactional';
