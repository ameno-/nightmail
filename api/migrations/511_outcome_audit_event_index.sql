-- bane:no-transaction
-- Probe one email's public events when auditing its outcome bits. The timestamp index cannot do that.
CREATE INDEX CONCURRENTLY IF NOT EXISTS operation_events_outcome_email ON operation_events (workspace_id, (data->>'emailId')) WHERE data ? 'emailId';
