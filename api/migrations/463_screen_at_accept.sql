SET LOCAL lock_timeout='2s';
-- Screen-at-accept: every email entering sending_emails is already content-screened (or unscreened by policy),
-- and failing personalized campaign copies are marked screen_rejected during prepare/screenAhead so they never
-- enter sending_emails. Both columns use instant metadata-only defaults in PostgreSQL 11+ (no table rewrite).
ALTER TABLE sending_emails ADD COLUMN IF NOT EXISTS screened boolean NOT NULL DEFAULT true;
ALTER TABLE sending_review_recipients ADD COLUMN IF NOT EXISTS screen_rejected boolean NOT NULL DEFAULT false;
-- Copies screened ahead by the previous code but not yet released were never marked screen_rejected: rewind each review's
-- cursor to what was released, so screenAhead judges them again from their stored verdicts (sending_campaign_screens, no
-- classifier request) and marks the refused ones before releaseStep queues them.
UPDATE sending_campaign_reviews r SET screen = jsonb_set(r.screen, '{screenedThrough}', to_jsonb(c.expanded))
  FROM sending_campaigns c WHERE c.workspace_id = r.workspace_id AND c.review_id = r.id AND c.state IN ('preparing', 'scheduled', 'sending', 'paused')
    AND jsonb_typeof(r.screen) = 'object' AND (r.screen->>'screenedThrough')::int > c.expanded;
