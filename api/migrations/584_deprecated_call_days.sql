SET LOCAL lock_timeout='2s';
-- One row per UTC day, retiring operation and authenticated workspace. An empty workspace
-- still counts a request rejected before authentication, but never counts as a workspace.
CREATE TABLE deprecated_call_days (
  day date NOT NULL,
  operation text NOT NULL,
  workspace_id text NOT NULL,
  calls bigint NOT NULL,
  PRIMARY KEY (day, operation, workspace_id)
);
