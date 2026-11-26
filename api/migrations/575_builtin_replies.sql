-- A reply from a built-in domain to a sender outside the workspace (NIGHTMAIL_BUILTIN_REPLIES, src/builtin-domain.ts
-- builtinReplyException): one row per received message answered that way, so each is answered at most once, and the
-- workspace's replies, and each recipient's across every workspace, in the last day are counted. Written in the send's transaction, under the
-- workspace's send locks: a refused send leaves none, and two concurrent replies are counted one after the other.
CREATE TABLE builtin_replies (
  workspace_id text NOT NULL,
  message_id text NOT NULL,
  recipient text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, message_id)
);
CREATE INDEX builtin_replies_day ON builtin_replies (workspace_id, created_at);
CREATE INDEX builtin_replies_recipient ON builtin_replies (recipient, created_at);
