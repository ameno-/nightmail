-- bane:no-transaction
-- Partial covering index for standing.refreshEvidence (src/standing.ts) and support deliveryMetrics
-- (src/deliverability.ts), which count unsubscribes per workspace over 7-30 days. Imports insert only
-- status='subscribed' rows, so this partial index adds zero write cost or WAL to imports.
CREATE INDEX CONCURRENTLY IF NOT EXISTS audience_consent_unsub_occurred ON audience_consent_audit(workspace_id, occurred_at) INCLUDE (source) WHERE status = 'unsubscribed';
