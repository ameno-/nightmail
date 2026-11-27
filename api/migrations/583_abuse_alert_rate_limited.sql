SET LOCAL lock_timeout='2s';
-- limited: how many 429s in a row Slack (or anything in front of it) answered an abuse alert's posts. Each 429 waits
-- longer (src/abuse-alerts.ts RATE_LIMIT_*); from ABUSE.rateLimitedMost in a row the alert counts as not delivered in
-- Health while it keeps waiting. Any other answer resets it. Expand-only.
ALTER TABLE abuse_alerts ADD COLUMN IF NOT EXISTS limited smallint NOT NULL DEFAULT 0 CHECK (limited >= 0);
