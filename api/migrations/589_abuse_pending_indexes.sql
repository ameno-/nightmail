-- bane:no-transaction
CREATE INDEX CONCURRENTLY IF NOT EXISTS abuse_signin_pending ON nightmail_signin_attempts(last_at,md5(issuer||' '||subject)) WHERE observed IS NOT NULL AND (last_at IS DISTINCT FROM abuse_folded_at OR attempts IS DISTINCT FROM abuse_folded_attempts);
CREATE INDEX CONCURRENTLY IF NOT EXISTS abuse_payment_pending ON billing_payment_attempts(updated_at,id) WHERE updated_at IS DISTINCT FROM abuse_folded_at;
CREATE INDEX CONCURRENTLY IF NOT EXISTS abuse_link_waiting ON identity_links(pending_since) WHERE pending;
CREATE INDEX CONCURRENTLY IF NOT EXISTS abuse_score_waiting ON abuse_clusters(score_requested_at) WHERE score_requested_at IS NOT NULL;
