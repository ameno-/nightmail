-- Held agent answers staff decide in the support inbox (src/support-inbox.ts): sent as the agent wrote it, edited and
-- sent, replaced by a fresh reply (one held because access shrank or written by an earlier build is never sent;
-- draft_reply: the staff reply), or discarded, by whom and when. Expand-only: nullable, and written only by those two
-- routes.
ALTER TABLE support_messages
  ADD COLUMN draft_outcome text CHECK (draft_outcome IN ('sent','edited','replaced','discarded')),
  ADD COLUMN draft_by text,
  ADD COLUMN draft_at timestamptz,
  ADD COLUMN draft_reply text,
  ADD CONSTRAINT support_messages_draft CHECK ((draft_outcome IS NULL) = (draft_by IS NULL AND draft_at IS NULL) AND (draft_reply IS NULL OR draft_outcome IN ('sent','edited','replaced')));
