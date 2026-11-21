-- bane:no-transaction
-- Retention deletes a finished send's Idempotency-Key with its email's log after 30 days (maintenance.ts SEND_KEYS,
-- whose predicate this repeats exactly). The table had only its primary key, so the hourly delete would scan it all.
-- A B-tree, not BRIN: rows arrive in created_at order, but the delete frees space the next inserts reuse and every other
-- key stays forever, so after one 30-day cycle each BRIN range spans the whole window and never narrows again (BRIN
-- summaries only widen). Partial: only finished sends, the rows the delete takes, so kept keys are never rescanned and
-- the index holds about 30 days of sends at roughly 20 bytes each. Built concurrently: sends keep writing meanwhile.
CREATE INDEX CONCURRENTLY IF NOT EXISTS sending_idempotency_expiry ON sending_idempotency (created_at) WHERE result IS NOT NULL AND (path IN ('/v1/emails/send','/v1/emails/batch','/v1/inbound/threads') OR path LIKE '/v1/campaigns/%/test' OR path LIKE '/v1/domains/%/test-send' OR path LIKE '/v1/inbound/threads/%/reply');
