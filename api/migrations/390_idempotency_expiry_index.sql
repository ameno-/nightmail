-- bane:no-transaction
-- Retention deletes a finished send's Idempotency-Key with its email's log (maintenance.ts SEND_KEYS and SCHEDULED_KEYS,
-- whose predicates these repeat exactly): after 30 days, or after 60 for a scheduled send. The table had only its primary
-- key, so the hourly delete would scan it all.
-- B-trees, not BRIN: rows arrive in created_at order, but the delete frees space the next inserts reuse and every other
-- key stays forever, so after one 30-day cycle each BRIN range spans the whole window and never narrows again (BRIN
-- summaries only widen). Partial: each holds only the rows its delete takes (about 20 bytes each), so kept keys are never
-- rescanned, and the scheduled keys, which wait longer, have their own index instead of sitting in front of the others.
-- Built concurrently: sends keep writing meanwhile.
CREATE INDEX CONCURRENTLY IF NOT EXISTS sending_idempotency_expiry ON sending_idempotency (created_at) WHERE result IS NOT NULL AND NOT (result ? 'scheduledAt') AND path ~ '^/v1/(emails/(send|batch)|campaigns/[^/]+/test|domains/[^/]+/test-send|inbound/threads(/[^/]+/reply)?)$';
CREATE INDEX CONCURRENTLY IF NOT EXISTS sending_idempotency_scheduled_expiry ON sending_idempotency (created_at) WHERE result ? 'scheduledAt' AND path ~ '^/v1/(emails/(send|batch)|campaigns/[^/]+/test|domains/[^/]+/test-send|inbound/threads(/[^/]+/reply)?)$';
