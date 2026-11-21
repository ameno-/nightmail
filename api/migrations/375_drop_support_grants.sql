-- Contract step for migration 334 (support conversations). Every support read now goes through a registered
-- conversation, and the release before this one (which no longer minted, read with or revoked a grant) is in
-- production, so support_grants and its routes go. Their trail stays in audit_events until its retain_until.
DROP TABLE support_grants;

-- A handoff opens one conversation, once. Handoffs that opened a grant expired (30 minutes) long before this release, so
-- they go with the grants. support_handoffs.grant_id goes in a later release: the Worker still serving while this
-- migration applies reads it when it checks a handoff, and only stops once this release's Worker replaces it.
DELETE FROM support_handoffs WHERE grant_id IS NOT NULL;
ALTER TABLE support_handoffs DROP CONSTRAINT support_handoffs_used_once;
ALTER TABLE support_handoffs ADD CONSTRAINT support_handoffs_used_once CHECK ((used_at IS NULL) = (conversation_id IS NULL) AND grant_id IS NULL);
