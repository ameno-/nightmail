-- bane:no-transaction
CREATE INDEX CONCURRENTLY IF NOT EXISTS abuse_link_waiting ON identity_links(pending_since) WHERE pending;
CREATE INDEX CONCURRENTLY IF NOT EXISTS abuse_score_waiting ON abuse_clusters(score_requested_at) WHERE score_requested_at IS NOT NULL;
