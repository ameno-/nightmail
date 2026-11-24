-- Support background chunked audience capture for large campaigns (>5,000 list members) and cached preview estimates.
-- All columns use NULL or a constant default, so PostgreSQL 11+ applies them metadata-only with no table rewrite.
-- Existing reviews automatically receive captured_at = now() (already captured before this migration).
ALTER TABLE sending_campaign_reviews
  ADD COLUMN IF NOT EXISTS captured_at timestamptz DEFAULT now(),
  ADD COLUMN IF NOT EXISTS captured_count integer,
  ADD COLUMN IF NOT EXISTS static_prepared boolean NOT NULL DEFAULT false;

ALTER TABLE sending_campaigns
  ADD COLUMN IF NOT EXISTS audience_estimate integer;

-- Allow state='preparing' with total=0, prepared=0 while a deferred large capture without a cached estimate is in flight.
ALTER TABLE sending_campaigns
  DROP CONSTRAINT IF EXISTS sending_campaigns_preparing,
  ADD CONSTRAINT sending_campaigns_preparing CHECK (state <> 'preparing' OR prepared < total OR (total = 0 AND prepared = 0)) NOT VALID;
ALTER TABLE sending_campaigns VALIDATE CONSTRAINT sending_campaigns_preparing;
