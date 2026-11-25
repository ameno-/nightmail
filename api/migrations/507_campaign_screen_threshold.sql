SET LOCAL lock_timeout='2s';
-- Keep the deciding window's cutoff with its score across job retries and cached campaign copies.
-- Pre-harm verdicts have different copy hashes and need no backfill.
ALTER TABLE sending_campaign_screens ADD COLUMN threshold double precision;
