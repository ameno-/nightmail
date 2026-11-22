SET LOCAL lock_timeout='2s';
-- The customer share (HOSTED_CUSTOMER_SHARE_PERCENT, src/dispatcher.ts): every outside workspace on a shared account
-- together may use at most that percent of the account's daily SES limit in a rolling 24 hours, so they can never
-- crowd out our own mail. Outside means Hosted and not exempt (exempt_hosted_quotas, our first-party workspace).
-- What they used is what SES counted on the pool account and region (sent_last_24_hours, read with every quota sample)
-- less what it accepted there for exempt workspaces, in the hours admission counts (real recipients, as
-- hosted_accepted_day in migration 348 counts them). The sum reads only the exempt workspaces' hours, however many
-- customers there are, and anything else on the account counts as theirs: an error holds them, never us. BYO
-- accounts are not pool accounts and have no customer use.
CREATE FUNCTION hosted_customer_day(account text, reg text, sent double precision) RETURNS double precision LANGUAGE sql STABLE AS $$
  SELECT CASE WHEN EXISTS (SELECT FROM provider_pool_regions p WHERE p.aws_account_id=account AND p.region=reg) THEN greatest(0, sent - coalesce((
    SELECT sum(h.accepted) FROM hosted_health_hourly h WHERE h.hour>=date_trunc('hour',now(),'UTC')-interval '23 hours' AND h.workspace_id IN (
      SELECT c.workspace_id FROM regional_connections c JOIN workspaces w ON w.id=c.workspace_id
      WHERE c.kind='shared' AND c.aws_account_id=account AND c.region=reg AND w.exempt_hosted_quotas)), 0)) ELSE 0 END
$$;
-- The dispatcher's elected quota refresh stores it beside SES's sample, once a minute per account and region, so no
-- send and no campaign release ever sums it.
ALTER TABLE provider_account_limits ADD COLUMN customer_sent_24_hours double precision NOT NULL DEFAULT 0;
CREATE OR REPLACE VIEW regional_workspace_limits AS SELECT c.workspace_id,l.aws_account_id,l.region,l.refresh_after,l.checked_at,
  CASE c.kind WHEN 'shared' THEN l.max_send_rate/4 ELSE l.max_send_rate END AS max_send_rate,l.max_24_hour_send,l.sent_last_24_hours,l.customer_sent_24_hours
  FROM regional_simulated_connections c JOIN provider_account_limits l USING(aws_account_id,region);
