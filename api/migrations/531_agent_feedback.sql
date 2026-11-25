SET LOCAL lock_timeout = '2s';
-- Agent feedback (POST /v1/feedback, src/feedback.ts): an agent reports what in Nightmail got in its way, and it lands in
-- the support inbox as a ticket on a conversation of its own channel, agent_feedback. Nightmail files it itself, with no
-- support platform behind it: it is bound to the reporting credential's workspace (verification 'credential'), to no
-- person, and nobody is emailed. support_feedback keeps what the ticket was filed with, for the per-workspace and
-- per-credential hourly limits and Glass's activity feed (critical reports); the report's text is the conversation's one
-- message, so it goes with the transcript (90 days after its ticket is resolved, src/maintenance.ts).

-- The checks that name the channel or the verification are replaced by named ones, with agent_feedback's rule added.
DO $$
DECLARE c record;
BEGIN
  FOR c IN SELECT conname FROM pg_constraint WHERE conrelid = 'support_conversations'::regclass AND contype = 'c'
      AND (pg_get_constraintdef(oid) LIKE '%channel%' OR pg_get_constraintdef(oid) LIKE '%verification%') LOOP
    EXECUTE format('ALTER TABLE support_conversations DROP CONSTRAINT %I', c.conname);
  END LOOP;
END $$;
ALTER TABLE support_conversations
  ADD CONSTRAINT support_conversations_channel CHECK (channel IN ('chat', 'email', 'agent_feedback')),
  ADD CONSTRAINT support_conversations_verification CHECK (verification IN ('handoff', 'dmarc', 'signin', 'none', 'credential')),
  -- A chat is a signed-in person's handoff; an email binds whoever its evidence proves; agent feedback is a workspace's
  -- credential and nobody's account.
  ADD CONSTRAINT support_conversations_binding CHECK (CASE channel
    WHEN 'chat' THEN verification = 'handoff' AND user_id IS NOT NULL AND workspace_id IS NOT NULL
    WHEN 'email' THEN verification <> 'credential'
    ELSE verification = 'credential' AND mode = 'unverified' AND user_id IS NULL AND workspace_id IS NOT NULL END),
  ADD CONSTRAINT support_conversations_content CHECK (content_workspace_id IS NULL OR (channel = 'chat' AND content_workspace_id = workspace_id));

CREATE TABLE support_feedback (
  conversation_id text PRIMARY KEY REFERENCES support_conversations(id) ON DELETE CASCADE,
  workspace_id text NOT NULL,
  credential text NOT NULL CHECK (credential IN ('apiKey', 'agentToken', 'mcp', 'dashboard')),
  credential_id text NOT NULL CHECK (length(credential_id) BETWEEN 1 AND 200),
  severity text NOT NULL CHECK (severity IN ('low', 'medium', 'high', 'critical')),
  kind text NOT NULL CHECK (kind IN ('bug', 'friction', 'feature', 'docs', 'other')),
  operation text CHECK (operation ~ '^[A-Za-z][A-Za-z0-9_.:-]{0,79}$'),
  request_id text CHECK (request_id ~ '^req_[0-9a-f]{32}$'),
  redacted integer NOT NULL DEFAULT 0 CHECK (redacted >= 0),
  created_at timestamptz NOT NULL DEFAULT now()
);
-- The hourly limits count a workspace's reports in the last hour, and a credential's among them.
CREATE INDEX support_feedback_workspace ON support_feedback (workspace_id, created_at);
-- Glass's activity feed: the newest critical reports.
CREATE INDEX support_feedback_critical ON support_feedback (created_at) WHERE severity = 'critical';
-- Retention: agent feedback is never closed, so its transcript goes 90 days after its ticket was resolved.
CREATE INDEX support_conversations_feedback_resolved ON support_conversations (ticket_resolved_at) WHERE channel = 'agent_feedback' AND ticket_resolved_at IS NOT NULL;
