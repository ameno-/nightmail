SET LOCAL lock_timeout = '2s';
-- A device code an agent asked for with a spent setup token (src/agent-setup.ts): the token's person and workspace, so
-- that person's dashboard shows the agent waiting for them (GET /v1/agent/device/waiting) with a button to /connect. It
-- only says whom the agent asks: approving still takes an owner or admin, signed in at /connect, choosing the workspace.
-- for_prompt_copied_at: when that person copied the prompt whose token the agent held, shown with the notice and on
-- /connect so a request long after their last copy, or with no agent started, looks wrong to them.
-- renewed_from: the expired code this one replaced (an agent polling after nobody approved in time gets one new code,
-- once), so a renewed code is never renewed again.
ALTER TABLE agent_setups
  ADD COLUMN for_workspace_id text REFERENCES workspaces(id) ON DELETE CASCADE,
  ADD COLUMN for_user_id text REFERENCES nightmail_users(id) ON DELETE CASCADE,
  ADD COLUMN for_prompt_copied_at timestamptz,
  ADD COLUMN renewed_from text,
  ADD CONSTRAINT agent_setups_for CHECK ((for_workspace_id IS NULL) = (for_user_id IS NULL) AND (for_user_id IS NULL) = (for_prompt_copied_at IS NULL) AND (kind = 'device' OR for_workspace_id IS NULL)),
  ADD CONSTRAINT agent_setups_renewed CHECK (kind = 'device' OR renewed_from IS NULL);
CREATE INDEX agent_setups_waiting ON agent_setups(for_workspace_id, for_user_id) WHERE kind = 'device' AND status = 'pending';
