-- One row per content-classifier request, for operators who read the database (src/screen-calls.ts): the same record
-- as its CONTENT_SCREEN_CALL log line (src/screen.ts). Every failure, every answered request for a single message, and
-- one in ten answered requests for campaign copies (sample_rate says which). IDs, codes, sizes and milliseconds only:
-- never content, subjects, addresses, request bodies or keys. Not in the API, the SDK, the dashboard or MCP.
-- - created_at: when the request started, on the Worker's clock.
-- - outcome: ok, timeout, network, http_<status> or invalid; phase: headers or body, for timeout and network.
-- - headers_ms: to the response headers; ms: to the end of the body, or to the failure.
-- - in_flight: classifier requests the isolate had in flight when this one started, this one included; ses_in_flight:
--   SES sends in flight in the isolate then. A Worker invocation waits for headers on at most six connections, so a
--   timeout before the headers with sends in flight may have queued on our side rather than at the classifier.
-- - request_id: the classifier's own request ID (x-typesafe-request-id), at most 80 characters.
-- - window_index of windows: which request of a message's screen (0-based).
-- Rows are written in one INSERT when a dispatch run or a job drain ends, never by a statement that records a send, and
-- kept 30 days (src/maintenance.ts retentionDrains). A new table: nothing existing is locked or changed.
SET LOCAL lock_timeout='2s';
CREATE TABLE IF NOT EXISTS content_screen_calls (
  created_at timestamptz NOT NULL,
  id bigint GENERATED ALWAYS AS IDENTITY,
  headers_ms integer,
  ms integer,
  request_bytes integer,
  response_bytes integer,
  sample_rate real NOT NULL DEFAULT 1,
  shard smallint,
  http_status smallint,
  in_flight smallint,
  ses_in_flight smallint,
  window_index smallint,
  windows smallint,
  required boolean,
  outcome text NOT NULL,
  phase text,
  kind text,
  region text,
  workspace_id text,
  email_id text,
  campaign_id text,
  request_id text CHECK (length(request_id) <= 80),
  PRIMARY KEY (created_at, id)
);
