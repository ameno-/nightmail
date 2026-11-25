-- Backfills sending_metrics_ten_minute (migration 499) for the last 7 days without locking sending_emails.
-- Migration 499's trigger functions are already committed, so concurrent writes add their own deltas and this
-- single-statement (exact - stored) diff is idempotent with zero double-counting.

WITH cutoff AS (
  SELECT date_bin('10 minutes', now() - interval '7 days', timestamptz '2000-01-01 00:00:00+00') AS since
)
INSERT INTO sending_metrics_ten_minute (
  workspace_id, region, kind, bucket,
  emails, accepted, delivered, bounced, complained, opened, clicked, failed, delivery_delayed, simulated
)
SELECT workspace_id, region, kind, bucket,
  sum(emails)::bigint, sum(accepted)::bigint, sum(delivered)::bigint, sum(bounced)::bigint,
  sum(complained)::bigint, sum(opened)::bigint, sum(clicked)::bigint, sum(failed)::bigint,
  sum(delivery_delayed)::bigint, sum(simulated)::bigint
FROM (
  SELECT workspace_id, region, coalesce(snapshot->>'kind', '') AS kind,
    date_bin('10 minutes', created_at, timestamptz '2000-01-01 00:00:00+00') AS bucket,
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
  FROM sending_emails, cutoff
  WHERE created_at >= cutoff.since
  GROUP BY 1, 2, 3, 4
  UNION ALL
  SELECT workspace_id, region, kind, bucket,
    -emails, -accepted, -delivered, -bounced, -complained, -opened, -clicked, -failed, -delivery_delayed, -simulated
  FROM sending_metrics_ten_minute, cutoff
  WHERE bucket >= cutoff.since
) difference
GROUP BY 1, 2, 3, 4
HAVING sum(emails) <> 0 OR sum(accepted) <> 0 OR sum(delivered) <> 0 OR sum(bounced) <> 0
    OR sum(complained) <> 0 OR sum(opened) <> 0 OR sum(clicked) <> 0 OR sum(failed) <> 0
    OR sum(delivery_delayed) <> 0 OR sum(simulated) <> 0;
