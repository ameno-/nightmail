-- The rest of migration 375's contract step: no Worker reads support_handoffs.grant_id any more (the release with 375 is
-- in production, and 375 removed every handoff that opened a grant), so the column goes. A handoff is used exactly when
-- it opened a conversation.
ALTER TABLE support_handoffs DROP CONSTRAINT support_handoffs_used_once;
ALTER TABLE support_handoffs DROP COLUMN grant_id;
ALTER TABLE support_handoffs ADD CONSTRAINT support_handoffs_used_once CHECK ((used_at IS NULL) = (conversation_id IS NULL));
