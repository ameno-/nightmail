SET LOCAL lock_timeout='2s';
-- Screen-at-accept: every email entering sending_emails is already content-screened (or unscreened by policy),
-- and failing personalized campaign copies are marked screen_rejected during prepare/screenAhead so they never
-- enter sending_emails. Both columns use instant metadata-only defaults in PostgreSQL 11+ (no table rewrite).
ALTER TABLE sending_emails ADD COLUMN IF NOT EXISTS screened boolean NOT NULL DEFAULT true;
ALTER TABLE sending_review_recipients ADD COLUMN IF NOT EXISTS screen_rejected boolean NOT NULL DEFAULT false;
