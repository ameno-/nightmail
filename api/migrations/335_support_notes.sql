-- Support notes (src/support-notes.ts, api/README.md "Support integration"). Internal: customers never call these routes.
--
-- What support keeps about one person between their conversations, in its own words. A note belongs to the person
-- (user_id, from the conversation it was written in, never from the request) and is tagged with the workspace that
-- conversation was scoped to when it was written (null: none chosen). It is read back only for that same person, and only
-- while it is untagged or they are still a member of its workspace; it is never shown to other members.
CREATE TABLE support_notes (
  id text PRIMARY KEY CHECK (id ~ '^snt_[0-9a-f]{32}$'),
  user_id text NOT NULL,
  workspace_id text,
  conversation_id text NOT NULL REFERENCES support_conversations(id),
  author text NOT NULL CHECK (author IN ('agent','staff')),
  text text NOT NULL CHECK (length(text) BETWEEN 1 AND 1000),
  -- clock_timestamp: notes written in quick succession keep their order, which decides the oldest to retire.
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  -- Retired: past the 50 live notes a person keeps, the oldest go.
  deleted_at timestamptz
);
CREATE INDEX support_notes_user_live ON support_notes (user_id, created_at) WHERE deleted_at IS NULL;
CREATE INDEX support_notes_conversation ON support_notes (conversation_id);
