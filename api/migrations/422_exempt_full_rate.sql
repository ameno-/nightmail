SET LOCAL lock_timeout='2s';
-- The campaign release planner (src/sending.ts, releaseStep) reads max_send_rate from this view on every release: the
-- buffer it keeps queued (ten seconds of the rate per campaign, twenty per workspace) and the rate a campaign's
-- rate share is a share of. A workspace on a shared connection has planned at a quarter of the pooled account's SES
-- rate since migration 047, so one customer's campaign never takes the pool. A workspace the operator exempted from
-- hosted quotas (workspaces.exempt_hosted_quotas, migration 082: our own first-party workspace) now plans at the full
-- pooled rate; every other shared workspace keeps the quarter and a BYO account keeps its own rate. Only max_send_rate
-- changes: the columns, their order and their types are migration 401's, so this is one catalog update with no rewrite.
-- To back out, run migration 401's CREATE OR REPLACE VIEW statement again in a new migration.
CREATE OR REPLACE VIEW regional_workspace_limits AS SELECT c.workspace_id,l.aws_account_id,l.region,l.refresh_after,l.checked_at,
  CASE WHEN c.kind='shared' AND NOT coalesce((SELECT w.exempt_hosted_quotas FROM workspaces w WHERE w.id=c.workspace_id),false) THEN l.max_send_rate/4 ELSE l.max_send_rate END AS max_send_rate,
  l.max_24_hour_send,l.sent_last_24_hours,l.customer_sent_24_hours
  FROM regional_simulated_connections c JOIN provider_account_limits l USING(aws_account_id,region);
