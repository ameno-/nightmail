SET LOCAL lock_timeout='2s';
-- Abuse alerts go out through the job queue (src/abuse-alerts.ts), review and high alike, a few an hour per level, and
-- the hourly job says when it runs out of time (src/abuse.ts). Expand-only.
-- status 'stale', stale_reason: an alert that no longer needed a look before it was posted (its cluster gone or below its
--   level, someone reviewed it, a day went by), so it never was. It stays readable in the Operator area.
-- claimed_at: when its post took one of its level's places in the hour (given back if the post is refused).
ALTER TABLE abuse_alerts DROP CONSTRAINT IF EXISTS abuse_alerts_status_check;
ALTER TABLE abuse_alerts ADD CONSTRAINT abuse_alerts_status_check CHECK (status IN ('stored','sent','failed','stale')),
  ADD COLUMN IF NOT EXISTS stale_reason text CHECK (stale_reason IN ('cluster_gone','band_dropped','reviewed','expired')),
  ADD COLUMN IF NOT EXISTS claimed_at timestamptz;
CREATE INDEX IF NOT EXISTS abuse_alerts_claimed ON abuse_alerts(band, claimed_at) WHERE claimed_at IS NOT NULL;
-- last_run: the hourly job's last run (each stage's time, the stages it stopped with work left). cut_runs: how many runs
-- in a row ran out of time somewhere.
ALTER TABLE abuse_state
  ADD COLUMN IF NOT EXISTS last_run jsonb CHECK (last_run IS NULL OR octet_length(last_run::text) <= 2000),
  ADD COLUMN IF NOT EXISTS cut_runs integer NOT NULL DEFAULT 0 CHECK (cut_runs >= 0);
