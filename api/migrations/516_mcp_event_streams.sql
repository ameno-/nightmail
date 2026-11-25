SET LOCAL lock_timeout='2s';
-- Open MCP event streams (src/mcp-events.ts): one lease per events/stream request, so one credential holds at most 10 at
-- once and one workspace 50. A stream renews its lease with each read and removes it when it closes; the lease of a
-- stream that died ends on its own (expires_at), and the next stream to open removes it.
CREATE TABLE IF NOT EXISTS mcp_event_streams (
  id text PRIMARY KEY,
  workspace_id text NOT NULL,
  holder text NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS mcp_event_streams_workspace ON mcp_event_streams (workspace_id, expires_at);
CREATE INDEX IF NOT EXISTS mcp_event_streams_expires ON mcp_event_streams (expires_at);
