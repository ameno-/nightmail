-- bane:no-transaction
-- A key's change history (listApiKeyChanges) and the latest change of each listed key (lastChange): the audit rows
-- about one key, newest first.
CREATE INDEX CONCURRENTLY IF NOT EXISTS audit_events_key_target ON audit_events(workspace_id,target_id,at DESC,id DESC) WHERE target_type IN ('api_key','inbox_key');
