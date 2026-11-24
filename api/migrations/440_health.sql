SET LOCAL lock_timeout='2s';
-- Health (src/health.ts): what the minute tick measured, the alerts it holds, and the request counters it reads.
-- Four new small tables and one small partial index; nothing here reads, rewrites or locks sending_emails,
-- sending_email_events or jobs.
--  - health_state: one row. tick_at elects one tick a minute (the UPDATE that claims it is also the probe that tells a
--    read-only database); rollup is what GET /v1/operator/health answers, so the page never runs a query of its own.
--  - health_alerts: one row per alert that is open: its key, severity, the number that matters, since when, and when
--    a card last went out. A row is deleted when its alert clears, so the table holds a handful of rows.
--  - health_minutes: counters by minute (requests per route with a latency histogram, one workspace's reads, 5xx by
--    error code, database errors by SQLSTATE, error-level log lines by code), written by each process every 20 seconds
--    in one statement: at most a few hundred rows a minute (one per route template that answered). Kept two hours.
--  - health_hours: the same counters by hour, folded from health_minutes as they age out and kept 30 days, so a
--    route's count and p95 outlive the three days Workers Logs keeps.
-- sending_campaigns_running: the tick reads the campaigns that are preparing, sending or paused, a handful among every
-- campaign ever made. sending_campaigns is small (one row per campaign, not per email), so building it takes
-- milliseconds; the lock wait is short and gives up rather than queue behind a long transaction.
CREATE TABLE health_state(singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton), tick_at timestamptz NOT NULL DEFAULT '-infinity', rollup jsonb, generated_at timestamptz);
INSERT INTO health_state DEFAULT VALUES;
CREATE TABLE health_alerts(key text PRIMARY KEY, kind text NOT NULL, severity text NOT NULL, value double precision NOT NULL DEFAULT 0, unit text NOT NULL DEFAULT '',
  words text NOT NULL DEFAULT '', since timestamptz NOT NULL DEFAULT now(), seen_at timestamptz NOT NULL DEFAULT now(), sent_at timestamptz);
CREATE TABLE health_minutes(minute timestamptz NOT NULL, kind text NOT NULL, key text NOT NULL, n integer NOT NULL DEFAULT 0, errors integer NOT NULL DEFAULT 0,
  ms bigint NOT NULL DEFAULT 0, slowest integer NOT NULL DEFAULT 0, hist integer[], PRIMARY KEY(minute, kind, key));
CREATE TABLE health_hours(hour timestamptz NOT NULL, kind text NOT NULL, key text NOT NULL, n bigint NOT NULL DEFAULT 0, errors bigint NOT NULL DEFAULT 0,
  ms bigint NOT NULL DEFAULT 0, slowest integer NOT NULL DEFAULT 0, hist bigint[], PRIMARY KEY(hour, kind, key));
CREATE INDEX sending_campaigns_running ON sending_campaigns(state, updated_at) WHERE state IN ('preparing','sending','paused');
