SET LOCAL lock_timeout='2s';
-- A domain's link host (src/link-domains.ts): links.<domain>, a CNAME to the installation's Cloudflare for SaaS target
-- (cname.nightmailedge.com on Hosted), served as a custom hostname of that zone (custom_hostname_id) with its own certificate.
-- Once active, the unsubscribe and other links in campaign and marketing mail from the domain use it. One row per
-- workspace and domain name, written by the domain's checks (with public_dns, what public DNS showed for the CNAME then)
-- and removed with the domain.
CREATE TABLE link_hosts (
  workspace_id text NOT NULL,
  domain text NOT NULL CHECK (domain = lower(domain) AND length(domain) <= 253),
  hostname text NOT NULL CHECK (hostname = lower(hostname) AND length(hostname) <= 253),
  custom_hostname_id text CHECK (length(custom_hostname_id) <= 64),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'active')),
  detail text CHECK (length(detail) <= 500),
  public_dns jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  checked_at timestamptz NOT NULL DEFAULT now(),
  verified_at timestamptz,
  PRIMARY KEY (workspace_id, domain)
);
CREATE INDEX link_hosts_custom_hostname ON link_hosts(custom_hostname_id) WHERE custom_hostname_id IS NOT NULL;

-- A campaign launched before link hosts waits for its sending domain's link record instead of failing its recipients
-- (src/sending.ts releaseStep): waiting_reason 'link_record', beside migration 500's 'ramp'. Same lock_timeout retry as 430.
DO $$
BEGIN
  FOR attempt IN 1..60 LOOP
    BEGIN
      SET LOCAL lock_timeout = '2s';
      ALTER TABLE sending_campaigns
        DROP CONSTRAINT IF EXISTS sending_campaigns_waiting_reason_check,
        ADD CONSTRAINT sending_campaigns_waiting_reason_check CHECK (
          waiting_reason IN ('pacing_window','ses_daily_quota','hosted_daily_quota','list_probe','balance','feedback_lag','ramp','link_record')
        ) NOT VALID;
      ALTER TABLE sending_campaigns VALIDATE CONSTRAINT sending_campaigns_waiting_reason_check;
      RETURN;
    EXCEPTION WHEN lock_not_available THEN
      PERFORM pg_sleep(1);
    END;
  END LOOP;
  RAISE EXCEPTION 'sending_campaigns was busy for 3 minutes. Nothing was changed: run the migration again.' USING ERRCODE = 'lock_not_available';
END $$;
