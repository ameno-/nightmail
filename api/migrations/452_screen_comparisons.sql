-- The second classifier in the shadow of the content screen (src/screen-shadow.ts): one row per request the screen
-- really made (a cache miss, one request per window), with how the screen's request ended and how the same request,
-- repeated afterwards to the second classifier, ended. Read by GET /v1/operator/screen-comparison and by operators who
-- read the database; nothing that sends mail reads it. IDs, digests, scores, codes and milliseconds only: never content,
-- subjects, addresses, request bodies or keys. Not in the public API, the SDK, the dashboard or MCP.
-- - created_at: when the screen's request started. pair_id: the pair's own ID; a pair is written once.
-- - kind: email (email_id), campaign_test (email_id and campaign_id) or campaign_copy (campaign_id; digest is the copy's
--   key, sending_campaign_screens.copy_hash, so a campaign has a row per request of each distinct copy, never per recipient).
-- - digest: for an email, the screen's verdict cache key. An email whose verdict came from the cache has no row of its
--   own: its DISPATCH_EMAIL line carries the digest's first 32 characters (screenDigest), and the rows that judged it
--   are at most an hour older (the cache's lifetime): created_at in that hour AND left(digest,32) = screenDigest.
-- - window_index of windows: which request of the message's screen (0-based).
-- - threshold: the spam probability the screen acted at then; jev_flagged and jevf_flagged: score >= threshold.
-- - jev_outcome: ok, timeout, network, http_<status> or invalid (as content_screen_calls.outcome).
-- - jevf_outcome: ok, rate_limited, timeout, network, http_<status>, invalid, refused_too_large (the request was over
--   its input limit), or the request was not repeated: skipped_breaker, skipped_rate_limited, skipped_backlog.
-- - *_ms: to the end of the answer, or to the failure. *_input_tokens: as each classifier reported them.
-- Rows are written in batches after the fact and kept 90 days (src/maintenance.ts retentionDrains). A new table:
-- nothing existing is locked or changed.
SET LOCAL lock_timeout='2s';
CREATE TABLE IF NOT EXISTS screen_comparisons (
  created_at timestamptz NOT NULL,
  id bigint GENERATED ALWAYS AS IDENTITY,
  threshold double precision,
  jev_score double precision,
  jevf_score double precision,
  jev_ms integer,
  jevf_ms integer,
  jev_input_tokens integer,
  jevf_input_tokens integer,
  window_index smallint NOT NULL,
  windows smallint NOT NULL,
  jev_http_status smallint,
  jevf_http_status smallint,
  jev_flagged boolean,
  jevf_flagged boolean,
  pair_id text NOT NULL CHECK (length(pair_id) <= 64),
  kind text NOT NULL,
  digest text NOT NULL,
  jev_outcome text NOT NULL,
  jevf_outcome text NOT NULL,
  workspace_id text,
  email_id text,
  campaign_id text,
  jev_model text,
  jevf_model text,
  jevf_request_id text CHECK (length(jevf_request_id) <= 80),
  PRIMARY KEY (created_at, id)
);
-- A pair is written once, however often its batch is.
CREATE UNIQUE INDEX IF NOT EXISTS screen_comparisons_pair ON screen_comparisons (pair_id);
-- From an email served from the verdict cache, or a campaign copy, to the requests that judged it.
CREATE INDEX IF NOT EXISTS screen_comparisons_digest ON screen_comparisons (digest, created_at);
CREATE INDEX IF NOT EXISTS screen_comparisons_email ON screen_comparisons (email_id) WHERE email_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS screen_comparisons_campaign ON screen_comparisons (campaign_id, created_at) WHERE campaign_id IS NOT NULL;
