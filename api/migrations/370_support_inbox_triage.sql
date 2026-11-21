-- The support inbox's triage (src/support-inbox.ts "Needs you"). Expand-only: every column is nullable and nothing
-- the deployed code writes is constrained.
--
-- A conversation gains when its ticket was filed (the oldest waiting ticket sorts first) and when staff last marked it
-- done (Done takes it out of Needs you until something new happens: a message, a failed delivery, more blocked work, a
-- ticket or a pause). Each staff member keeps their own read marker per conversation: how many of its messages they
-- have read.
ALTER TABLE support_conversations
  ADD COLUMN ticket_at timestamptz,
  ADD COLUMN done_at timestamptz,
  ADD COLUMN done_by text,
  ADD CONSTRAINT support_conversations_done CHECK ((done_at IS NULL) = (done_by IS NULL));
UPDATE support_conversations SET ticket_at = coalesce(last_message_at, created_at) WHERE ticket_id IS NOT NULL;

CREATE TABLE support_inbox_reads (
  user_id text NOT NULL,
  conversation_id text NOT NULL REFERENCES support_conversations(id) ON DELETE CASCADE,
  seq integer NOT NULL CHECK (seq >= 0),
  read_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, conversation_id)
);
CREATE INDEX support_inbox_reads_conversation ON support_inbox_reads (conversation_id);
