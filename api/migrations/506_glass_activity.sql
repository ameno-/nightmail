SET LOCAL lock_timeout='2s';
-- Glass's activity feed (src/glass.ts readActivity) lists a domain's verification and a campaign's launch as they
-- happen. Neither had a time of its own, so a trigger now records each, whatever code path makes the change:
--   domain_claims.verified_at: when sending_state first became 'verified' (for a built-in domain: when it was ready).
--   sending_campaigns.launched_at: when the campaign left its draft for preparing, scheduled or sending.
-- Rows from before this migration keep null and are not in the feed. Each has a partial index on the time, so the feed
-- reads the newest few without a scan; campaigns' paused_at gets one for the same reason.
ALTER TABLE domain_claims ADD COLUMN verified_at timestamptz;
ALTER TABLE sending_campaigns ADD COLUMN launched_at timestamptz;

CREATE FUNCTION domain_claims_verified_at() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.verified_at := now(); RETURN NEW; END $$;
CREATE TRIGGER domain_claims_verified_at BEFORE INSERT OR UPDATE OF sending_state ON domain_claims FOR EACH ROW
  WHEN (NEW.sending_state='verified' AND NEW.verified_at IS NULL) EXECUTE FUNCTION domain_claims_verified_at();

CREATE FUNCTION sending_campaigns_launched_at() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.launched_at := now(); RETURN NEW; END $$;
CREATE TRIGGER sending_campaigns_launched_at BEFORE UPDATE OF state ON sending_campaigns FOR EACH ROW
  WHEN (OLD.state='draft' AND NEW.state IN ('preparing','scheduled','sending') AND NEW.launched_at IS NULL) EXECUTE FUNCTION sending_campaigns_launched_at();

CREATE INDEX domain_claims_verified ON domain_claims(verified_at) WHERE verified_at IS NOT NULL;
CREATE INDEX sending_campaigns_launched ON sending_campaigns(launched_at) WHERE launched_at IS NOT NULL;
CREATE INDEX sending_campaigns_paused ON sending_campaigns(paused_at) WHERE paused_at IS NOT NULL;
