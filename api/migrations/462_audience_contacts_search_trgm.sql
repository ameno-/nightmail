-- bane:no-transaction
-- Active contact email/name substring search; pg_trgm is installed by 065_log_search.sql.
CREATE INDEX CONCURRENTLY IF NOT EXISTS audience_contacts_search_trgm ON audience_contacts USING gin (lower(email) gin_trgm_ops, lower(name) gin_trgm_ops) WHERE deleted_at IS NULL;
