-- bane:no-transaction
-- Addresses hard-bounced anywhere, for the dead check on new contacts and the hourly pass (bouncedElsewhere): a few rows per bounce.
CREATE INDEX CONCURRENTLY IF NOT EXISTS audience_contacts_hard_bounced ON audience_contacts (email) WHERE suppressed AND suppression_reason = 'hard_bounce';
-- The contacts campaigns skip, for the risky counts in the campaign review and the Audience filter: a few percent of a list.
CREATE INDEX CONCURRENTLY IF NOT EXISTS audience_contacts_risky ON audience_contacts (workspace_id, id) WHERE risk IS NOT NULL AND NOT risk_allowed AND deleted_at IS NULL;
