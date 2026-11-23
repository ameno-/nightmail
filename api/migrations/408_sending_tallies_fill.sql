-- Backfills sending_campaign_tallies and sending_metrics_hourly (migration 407) with every campaign's and workspace's
-- exact counts as of each statement's snapshot. Migration 407's triggers are already committed, so concurrent writes
-- (including a 1.8M-recipient campaign mid-send) add their own delta rows:
-- - Any transaction committed BEFORE this statement's snapshot appears in BOTH sending_emails and the tally table, so
--   (exact - stored) excludes it (no double-count).
-- - Any transaction committed AFTER this statement's snapshot appears in NEITHER side of the snapshot, and its trigger
--   adds its delta row independently.
-- Nothing on sending_emails is locked against writes, and running this migration again inserts 0 rows (idempotent).

INSERT INTO sending_campaign_tallies (
  workspace_id, campaign_id, status, simulated,
  email_count, accepted, delivered, bounced, complained, opened, clicked, failed, delivery_delayed
)
SELECT workspace_id, campaign_id, status, simulated,
  sum(email_count)::bigint, sum(accepted)::bigint, sum(delivered)::bigint, sum(bounced)::bigint,
  sum(complained)::bigint, sum(opened)::bigint, sum(clicked)::bigint, sum(failed)::bigint, sum(delivery_delayed)::bigint
FROM (
  SELECT workspace_id, campaign_id, status, simulated,
    count(*)::bigint AS email_count,
    count(*) FILTER (WHERE NOT simulated AND status <> 'suppressed' AND (provider_id IS NOT NULL OR status IN ('accepted','sent','delivered','bounced','complained','delayed') OR (event_outcomes & 1) <> 0))::bigint AS accepted,
    count(*) FILTER (WHERE status = 'delivered' OR (event_outcomes & 2) <> 0)::bigint AS delivered,
    count(*) FILTER (WHERE status = 'bounced' OR (event_outcomes & 4) <> 0)::bigint AS bounced,
    count(*) FILTER (WHERE status = 'complained' OR (event_outcomes & 8) <> 0)::bigint AS complained,
    count(*) FILTER (WHERE (event_outcomes & 16) <> 0)::bigint AS opened,
    count(*) FILTER (WHERE (event_outcomes & 32) <> 0)::bigint AS clicked,
    count(*) FILTER (WHERE status IN ('rejected','rendering_failed') OR (event_outcomes & 64) <> 0)::bigint AS failed,
    count(*) FILTER (WHERE status = 'delayed' OR (event_outcomes & 128) <> 0)::bigint AS delivery_delayed
  FROM sending_emails
  WHERE campaign_id IS NOT NULL
  GROUP BY 1, 2, 3, 4
  UNION ALL
  SELECT workspace_id, campaign_id, status, simulated,
    -email_count, -accepted, -delivered, -bounced, -complained, -opened, -clicked, -failed, -delivery_delayed
  FROM sending_campaign_tallies
) difference
GROUP BY 1, 2, 3, 4
HAVING sum(email_count) <> 0 OR sum(accepted) <> 0 OR sum(delivered) <> 0 OR sum(bounced) <> 0
    OR sum(complained) <> 0 OR sum(opened) <> 0 OR sum(clicked) <> 0 OR sum(failed) <> 0 OR sum(delivery_delayed) <> 0;

INSERT INTO sending_metrics_hourly (
  workspace_id, region, kind, hour,
  emails, accepted, delivered, bounced, complained, opened, clicked, failed, delivery_delayed, simulated
)
SELECT workspace_id, region, kind, hour,
  sum(emails)::bigint, sum(accepted)::bigint, sum(delivered)::bigint, sum(bounced)::bigint,
  sum(complained)::bigint, sum(opened)::bigint, sum(clicked)::bigint, sum(failed)::bigint,
  sum(delivery_delayed)::bigint, sum(simulated)::bigint
FROM (
  SELECT workspace_id, region, coalesce(snapshot->>'kind', '') AS kind, date_trunc('hour', created_at, 'UTC') AS hour,
    count(*)::bigint AS emails,
    count(*) FILTER (WHERE NOT simulated AND status <> 'suppressed' AND (provider_id IS NOT NULL OR status IN ('accepted','sent','delivered','bounced','complained','delayed') OR (event_outcomes & 1) <> 0))::bigint AS accepted,
    count(*) FILTER (WHERE status = 'delivered' OR (event_outcomes & 2) <> 0)::bigint AS delivered,
    count(*) FILTER (WHERE status = 'bounced' OR (event_outcomes & 4) <> 0)::bigint AS bounced,
    count(*) FILTER (WHERE status = 'complained' OR (event_outcomes & 8) <> 0)::bigint AS complained,
    count(*) FILTER (WHERE (event_outcomes & 16) <> 0)::bigint AS opened,
    count(*) FILTER (WHERE (event_outcomes & 32) <> 0)::bigint AS clicked,
    count(*) FILTER (WHERE status IN ('rejected','rendering_failed') OR (event_outcomes & 64) <> 0)::bigint AS failed,
    count(*) FILTER (WHERE status = 'delayed' OR (event_outcomes & 128) <> 0)::bigint AS delivery_delayed,
    count(*) FILTER (WHERE simulated)::bigint AS simulated
  FROM sending_emails
  GROUP BY 1, 2, 3, 4
  UNION ALL
  SELECT workspace_id, region, kind, hour,
    -emails, -accepted, -delivered, -bounced, -complained, -opened, -clicked, -failed, -delivery_delayed, -simulated
  FROM sending_metrics_hourly
) difference
GROUP BY 1, 2, 3, 4
HAVING sum(emails) <> 0 OR sum(accepted) <> 0 OR sum(delivered) <> 0 OR sum(bounced) <> 0
    OR sum(complained) <> 0 OR sum(opened) <> 0 OR sum(clicked) <> 0 OR sum(failed) <> 0
    OR sum(delivery_delayed) <> 0 OR sum(simulated) <> 0;
