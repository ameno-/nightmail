-- 10-minute rolling sending metrics rollup for granular 24h Overview activity charts.
-- Follows the exact same insert-only delta pattern as sending_metrics_hourly (migration 407):
-- - CREATE OR REPLACE FUNCTION updates the existing statement triggers with ZERO table lock on sending_emails.
-- - Only tracks recent mail (created_at >= now() - interval '7 days'), so historical retention deletes add zero rows.
-- - Bounded per-minute fold (fold_sending_metrics_ten_minute) and daily reconcile + prune (> 7 days old) keep the table
--   small (at most 1,008 folded rows per active workspace/region/kind) and reads under ~1 ms.

CREATE TABLE sending_metrics_ten_minute (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  workspace_id text NOT NULL,
  region text NOT NULL,
  kind text NOT NULL,
  bucket timestamptz NOT NULL,
  emails bigint NOT NULL DEFAULT 0,
  accepted bigint NOT NULL DEFAULT 0,
  delivered bigint NOT NULL DEFAULT 0,
  bounced bigint NOT NULL DEFAULT 0,
  complained bigint NOT NULL DEFAULT 0,
  opened bigint NOT NULL DEFAULT 0,
  clicked bigint NOT NULL DEFAULT 0,
  failed bigint NOT NULL DEFAULT 0,
  delivery_delayed bigint NOT NULL DEFAULT 0,
  simulated bigint NOT NULL DEFAULT 0
);
CREATE INDEX sending_metrics_ten_minute_lookup
  ON sending_metrics_ten_minute (workspace_id, bucket, region, kind);
CREATE INDEX sending_metrics_ten_minute_bucket
  ON sending_metrics_ten_minute (bucket);

CREATE OR REPLACE FUNCTION sending_tally_insert() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO sending_campaign_tallies (
    workspace_id, campaign_id, status, simulated,
    email_count, accepted, delivered, bounced, complained, opened, clicked, failed, delivery_delayed
  )
  SELECT
    workspace_id, campaign_id, status, simulated,
    count(*),
    count(*) FILTER (WHERE NOT simulated AND status <> 'suppressed' AND (provider_id IS NOT NULL OR status IN ('accepted','sent','delivered','bounced','complained','delayed') OR (event_outcomes & 1) <> 0)),
    count(*) FILTER (WHERE status = 'delivered' OR (event_outcomes & 2) <> 0),
    count(*) FILTER (WHERE status = 'bounced' OR (event_outcomes & 4) <> 0),
    count(*) FILTER (WHERE status = 'complained' OR (event_outcomes & 8) <> 0),
    count(*) FILTER (WHERE (event_outcomes & 16) <> 0),
    count(*) FILTER (WHERE (event_outcomes & 32) <> 0),
    count(*) FILTER (WHERE status IN ('rejected','rendering_failed') OR (event_outcomes & 64) <> 0),
    count(*) FILTER (WHERE status = 'delayed' OR (event_outcomes & 128) <> 0)
  FROM new_mail
  WHERE campaign_id IS NOT NULL
  GROUP BY 1, 2, 3, 4;

  INSERT INTO sending_metrics_hourly (
    workspace_id, region, kind, hour,
    emails, accepted, delivered, bounced, complained, opened, clicked, failed, delivery_delayed, simulated
  )
  SELECT
    workspace_id, region, coalesce(snapshot->>'kind', ''), date_trunc('hour', created_at, 'UTC'),
    count(*),
    count(*) FILTER (WHERE NOT simulated AND status <> 'suppressed' AND (provider_id IS NOT NULL OR status IN ('accepted','sent','delivered','bounced','complained','delayed') OR (event_outcomes & 1) <> 0)),
    count(*) FILTER (WHERE status = 'delivered' OR (event_outcomes & 2) <> 0),
    count(*) FILTER (WHERE status = 'bounced' OR (event_outcomes & 4) <> 0),
    count(*) FILTER (WHERE status = 'complained' OR (event_outcomes & 8) <> 0),
    count(*) FILTER (WHERE (event_outcomes & 16) <> 0),
    count(*) FILTER (WHERE (event_outcomes & 32) <> 0),
    count(*) FILTER (WHERE status IN ('rejected','rendering_failed') OR (event_outcomes & 64) <> 0),
    count(*) FILTER (WHERE status = 'delayed' OR (event_outcomes & 128) <> 0),
    count(*) FILTER (WHERE simulated)
  FROM new_mail
  GROUP BY 1, 2, 3, 4;

  INSERT INTO sending_metrics_ten_minute (
    workspace_id, region, kind, bucket,
    emails, accepted, delivered, bounced, complained, opened, clicked, failed, delivery_delayed, simulated
  )
  SELECT
    workspace_id, region, coalesce(snapshot->>'kind', ''),
    date_bin('10 minutes', created_at, timestamptz '2000-01-01 00:00:00+00'),
    count(*),
    count(*) FILTER (WHERE NOT simulated AND status <> 'suppressed' AND (provider_id IS NOT NULL OR status IN ('accepted','sent','delivered','bounced','complained','delayed') OR (event_outcomes & 1) <> 0)),
    count(*) FILTER (WHERE status = 'delivered' OR (event_outcomes & 2) <> 0),
    count(*) FILTER (WHERE status = 'bounced' OR (event_outcomes & 4) <> 0),
    count(*) FILTER (WHERE status = 'complained' OR (event_outcomes & 8) <> 0),
    count(*) FILTER (WHERE (event_outcomes & 16) <> 0),
    count(*) FILTER (WHERE (event_outcomes & 32) <> 0),
    count(*) FILTER (WHERE status IN ('rejected','rendering_failed') OR (event_outcomes & 64) <> 0),
    count(*) FILTER (WHERE status = 'delayed' OR (event_outcomes & 128) <> 0),
    count(*) FILTER (WHERE simulated)
  FROM new_mail
  WHERE created_at >= now() - interval '7 days'
  GROUP BY 1, 2, 3, 4;

  RETURN NULL;
END $$;

CREATE OR REPLACE FUNCTION sending_tally_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  WITH diffs AS (
    SELECT workspace_id, campaign_id, status, simulated,
      sum(d_cnt) AS email_count, sum(d_acc) AS accepted, sum(d_del) AS delivered,
      sum(d_bnc) AS bounced, sum(d_cmp) AS complained, sum(d_opn) AS opened,
      sum(d_clk) AS clicked, sum(d_fld) AS failed, sum(d_dly) AS delivery_delayed
    FROM (
      SELECT workspace_id, campaign_id, status, simulated, 1::bigint AS d_cnt,
        (NOT simulated AND status <> 'suppressed' AND (provider_id IS NOT NULL OR status IN ('accepted','sent','delivered','bounced','complained','delayed') OR (event_outcomes & 1) <> 0))::int::bigint AS d_acc,
        (status = 'delivered' OR (event_outcomes & 2) <> 0)::int::bigint AS d_del,
        (status = 'bounced' OR (event_outcomes & 4) <> 0)::int::bigint AS d_bnc,
        (status = 'complained' OR (event_outcomes & 8) <> 0)::int::bigint AS d_cmp,
        ((event_outcomes & 16) <> 0)::int::bigint AS d_opn,
        ((event_outcomes & 32) <> 0)::int::bigint AS d_clk,
        (status IN ('rejected','rendering_failed') OR (event_outcomes & 64) <> 0)::int::bigint AS d_fld,
        (status = 'delayed' OR (event_outcomes & 128) <> 0)::int::bigint AS d_dly
      FROM new_mail WHERE campaign_id IS NOT NULL
      UNION ALL
      SELECT workspace_id, campaign_id, status, simulated, -1::bigint,
        -(NOT simulated AND status <> 'suppressed' AND (provider_id IS NOT NULL OR status IN ('accepted','sent','delivered','bounced','complained','delayed') OR (event_outcomes & 1) <> 0))::int::bigint,
        -(status = 'delivered' OR (event_outcomes & 2) <> 0)::int::bigint,
        -(status = 'bounced' OR (event_outcomes & 4) <> 0)::int::bigint,
        -(status = 'complained' OR (event_outcomes & 8) <> 0)::int::bigint,
        -((event_outcomes & 16) <> 0)::int::bigint,
        -((event_outcomes & 32) <> 0)::int::bigint,
        -(status IN ('rejected','rendering_failed') OR (event_outcomes & 64) <> 0)::int::bigint,
        -(status = 'delayed' OR (event_outcomes & 128) <> 0)::int::bigint
      FROM old_mail WHERE campaign_id IS NOT NULL
    ) s
    GROUP BY 1, 2, 3, 4
    HAVING sum(d_cnt) <> 0 OR sum(d_acc) <> 0 OR sum(d_del) <> 0 OR sum(d_bnc) <> 0
        OR sum(d_cmp) <> 0 OR sum(d_opn) <> 0 OR sum(d_clk) <> 0 OR sum(d_fld) <> 0 OR sum(d_dly) <> 0
  )
  INSERT INTO sending_campaign_tallies (
    workspace_id, campaign_id, status, simulated,
    email_count, accepted, delivered, bounced, complained, opened, clicked, failed, delivery_delayed
  ) SELECT * FROM diffs;

  WITH diffs AS (
    SELECT workspace_id, region, kind, hour,
      sum(d_cnt) AS emails, sum(d_acc) AS accepted, sum(d_del) AS delivered,
      sum(d_bnc) AS bounced, sum(d_cmp) AS complained, sum(d_opn) AS opened,
      sum(d_clk) AS clicked, sum(d_fld) AS failed, sum(d_dly) AS delivery_delayed, sum(d_sim) AS simulated
    FROM (
      SELECT workspace_id, region, coalesce(snapshot->>'kind', '') AS kind, date_trunc('hour', created_at, 'UTC') AS hour, 1::bigint AS d_cnt,
        (NOT simulated AND status <> 'suppressed' AND (provider_id IS NOT NULL OR status IN ('accepted','sent','delivered','bounced','complained','delayed') OR (event_outcomes & 1) <> 0))::int::bigint AS d_acc,
        (status = 'delivered' OR (event_outcomes & 2) <> 0)::int::bigint AS d_del,
        (status = 'bounced' OR (event_outcomes & 4) <> 0)::int::bigint AS d_bnc,
        (status = 'complained' OR (event_outcomes & 8) <> 0)::int::bigint AS d_cmp,
        ((event_outcomes & 16) <> 0)::int::bigint AS d_opn,
        ((event_outcomes & 32) <> 0)::int::bigint AS d_clk,
        (status IN ('rejected','rendering_failed') OR (event_outcomes & 64) <> 0)::int::bigint AS d_fld,
        (status = 'delayed' OR (event_outcomes & 128) <> 0)::int::bigint AS d_dly,
        simulated::int::bigint AS d_sim
      FROM new_mail
      UNION ALL
      SELECT workspace_id, region, coalesce(snapshot->>'kind', ''), date_trunc('hour', created_at, 'UTC'), -1::bigint,
        -(NOT simulated AND status <> 'suppressed' AND (provider_id IS NOT NULL OR status IN ('accepted','sent','delivered','bounced','complained','delayed') OR (event_outcomes & 1) <> 0))::int::bigint,
        -(status = 'delivered' OR (event_outcomes & 2) <> 0)::int::bigint,
        -(status = 'bounced' OR (event_outcomes & 4) <> 0)::int::bigint,
        -(status = 'complained' OR (event_outcomes & 8) <> 0)::int::bigint,
        -((event_outcomes & 16) <> 0)::int::bigint,
        -((event_outcomes & 32) <> 0)::int::bigint,
        -(status IN ('rejected','rendering_failed') OR (event_outcomes & 64) <> 0)::int::bigint,
        -(status = 'delayed' OR (event_outcomes & 128) <> 0)::int::bigint,
        -simulated::int::bigint
      FROM old_mail
    ) s
    GROUP BY 1, 2, 3, 4
    HAVING sum(d_cnt) <> 0 OR sum(d_acc) <> 0 OR sum(d_del) <> 0 OR sum(d_bnc) <> 0
        OR sum(d_cmp) <> 0 OR sum(d_opn) <> 0 OR sum(d_clk) <> 0 OR sum(d_fld) <> 0 OR sum(d_dly) <> 0 OR sum(d_sim) <> 0
  )
  INSERT INTO sending_metrics_hourly (
    workspace_id, region, kind, hour,
    emails, accepted, delivered, bounced, complained, opened, clicked, failed, delivery_delayed, simulated
  ) SELECT * FROM diffs;

  WITH diffs AS (
    SELECT workspace_id, region, kind, bucket,
      sum(d_cnt) AS emails, sum(d_acc) AS accepted, sum(d_del) AS delivered,
      sum(d_bnc) AS bounced, sum(d_cmp) AS complained, sum(d_opn) AS opened,
      sum(d_clk) AS clicked, sum(d_fld) AS failed, sum(d_dly) AS delivery_delayed, sum(d_sim) AS simulated
    FROM (
      SELECT workspace_id, region, coalesce(snapshot->>'kind', '') AS kind,
        date_bin('10 minutes', created_at, timestamptz '2000-01-01 00:00:00+00') AS bucket, 1::bigint AS d_cnt,
        (NOT simulated AND status <> 'suppressed' AND (provider_id IS NOT NULL OR status IN ('accepted','sent','delivered','bounced','complained','delayed') OR (event_outcomes & 1) <> 0))::int::bigint AS d_acc,
        (status = 'delivered' OR (event_outcomes & 2) <> 0)::int::bigint AS d_del,
        (status = 'bounced' OR (event_outcomes & 4) <> 0)::int::bigint AS d_bnc,
        (status = 'complained' OR (event_outcomes & 8) <> 0)::int::bigint AS d_cmp,
        ((event_outcomes & 16) <> 0)::int::bigint AS d_opn,
        ((event_outcomes & 32) <> 0)::int::bigint AS d_clk,
        (status IN ('rejected','rendering_failed') OR (event_outcomes & 64) <> 0)::int::bigint AS d_fld,
        (status = 'delayed' OR (event_outcomes & 128) <> 0)::int::bigint AS d_dly,
        simulated::int::bigint AS d_sim
      FROM new_mail
      WHERE created_at >= now() - interval '7 days'
      UNION ALL
      SELECT workspace_id, region, coalesce(snapshot->>'kind', ''),
        date_bin('10 minutes', created_at, timestamptz '2000-01-01 00:00:00+00'), -1::bigint,
        -(NOT simulated AND status <> 'suppressed' AND (provider_id IS NOT NULL OR status IN ('accepted','sent','delivered','bounced','complained','delayed') OR (event_outcomes & 1) <> 0))::int::bigint,
        -(status = 'delivered' OR (event_outcomes & 2) <> 0)::int::bigint,
        -(status = 'bounced' OR (event_outcomes & 4) <> 0)::int::bigint,
        -(status = 'complained' OR (event_outcomes & 8) <> 0)::int::bigint,
        -((event_outcomes & 16) <> 0)::int::bigint,
        -((event_outcomes & 32) <> 0)::int::bigint,
        -(status IN ('rejected','rendering_failed') OR (event_outcomes & 64) <> 0)::int::bigint,
        -(status = 'delayed' OR (event_outcomes & 128) <> 0)::int::bigint,
        -simulated::int::bigint
      FROM old_mail
      WHERE created_at >= now() - interval '7 days'
    ) s
    GROUP BY 1, 2, 3, 4
    HAVING sum(d_cnt) <> 0 OR sum(d_acc) <> 0 OR sum(d_del) <> 0 OR sum(d_bnc) <> 0
        OR sum(d_cmp) <> 0 OR sum(d_opn) <> 0 OR sum(d_clk) <> 0 OR sum(d_fld) <> 0 OR sum(d_dly) <> 0 OR sum(d_sim) <> 0
  )
  INSERT INTO sending_metrics_ten_minute (
    workspace_id, region, kind, bucket,
    emails, accepted, delivered, bounced, complained, opened, clicked, failed, delivery_delayed, simulated
  ) SELECT * FROM diffs;

  RETURN NULL;
END $$;

CREATE OR REPLACE FUNCTION sending_tally_delete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO sending_campaign_tallies (
    workspace_id, campaign_id, status, simulated,
    email_count, accepted, delivered, bounced, complained, opened, clicked, failed, delivery_delayed
  )
  SELECT
    workspace_id, campaign_id, status, simulated,
    -count(*),
    -count(*) FILTER (WHERE NOT simulated AND status <> 'suppressed' AND (provider_id IS NOT NULL OR status IN ('accepted','sent','delivered','bounced','complained','delayed') OR (event_outcomes & 1) <> 0)),
    -count(*) FILTER (WHERE status = 'delivered' OR (event_outcomes & 2) <> 0),
    -count(*) FILTER (WHERE status = 'bounced' OR (event_outcomes & 4) <> 0),
    -count(*) FILTER (WHERE status = 'complained' OR (event_outcomes & 8) <> 0),
    -count(*) FILTER (WHERE (event_outcomes & 16) <> 0),
    -count(*) FILTER (WHERE (event_outcomes & 32) <> 0),
    -count(*) FILTER (WHERE status IN ('rejected','rendering_failed') OR (event_outcomes & 64) <> 0),
    -count(*) FILTER (WHERE status = 'delayed' OR (event_outcomes & 128) <> 0)
  FROM old_mail
  WHERE campaign_id IS NOT NULL
  GROUP BY 1, 2, 3, 4;

  INSERT INTO sending_metrics_hourly (
    workspace_id, region, kind, hour,
    emails, accepted, delivered, bounced, complained, opened, clicked, failed, delivery_delayed, simulated
  )
  SELECT
    workspace_id, region, coalesce(snapshot->>'kind', ''), date_trunc('hour', created_at, 'UTC'),
    -count(*),
    -count(*) FILTER (WHERE NOT simulated AND status <> 'suppressed' AND (provider_id IS NOT NULL OR status IN ('accepted','sent','delivered','bounced','complained','delayed') OR (event_outcomes & 1) <> 0)),
    -count(*) FILTER (WHERE status = 'delivered' OR (event_outcomes & 2) <> 0),
    -count(*) FILTER (WHERE status = 'bounced' OR (event_outcomes & 4) <> 0),
    -count(*) FILTER (WHERE status = 'complained' OR (event_outcomes & 8) <> 0),
    -count(*) FILTER (WHERE (event_outcomes & 16) <> 0),
    -count(*) FILTER (WHERE (event_outcomes & 32) <> 0),
    -count(*) FILTER (WHERE status IN ('rejected','rendering_failed') OR (event_outcomes & 64) <> 0),
    -count(*) FILTER (WHERE status = 'delayed' OR (event_outcomes & 128) <> 0),
    -count(*) FILTER (WHERE simulated)
  FROM old_mail
  GROUP BY 1, 2, 3, 4;

  INSERT INTO sending_metrics_ten_minute (
    workspace_id, region, kind, bucket,
    emails, accepted, delivered, bounced, complained, opened, clicked, failed, delivery_delayed, simulated
  )
  SELECT
    workspace_id, region, coalesce(snapshot->>'kind', ''),
    date_bin('10 minutes', created_at, timestamptz '2000-01-01 00:00:00+00'),
    -count(*),
    -count(*) FILTER (WHERE NOT simulated AND status <> 'suppressed' AND (provider_id IS NOT NULL OR status IN ('accepted','sent','delivered','bounced','complained','delayed') OR (event_outcomes & 1) <> 0)),
    -count(*) FILTER (WHERE status = 'delivered' OR (event_outcomes & 2) <> 0),
    -count(*) FILTER (WHERE status = 'bounced' OR (event_outcomes & 4) <> 0),
    -count(*) FILTER (WHERE status = 'complained' OR (event_outcomes & 8) <> 0),
    -count(*) FILTER (WHERE (event_outcomes & 16) <> 0),
    -count(*) FILTER (WHERE (event_outcomes & 32) <> 0),
    -count(*) FILTER (WHERE status IN ('rejected','rendering_failed') OR (event_outcomes & 64) <> 0),
    -count(*) FILTER (WHERE status = 'delayed' OR (event_outcomes & 128) <> 0),
    -count(*) FILTER (WHERE simulated)
  FROM old_mail
  WHERE created_at >= now() - interval '7 days'
  GROUP BY 1, 2, 3, 4;

  RETURN NULL;
END $$;

CREATE FUNCTION fold_sending_metrics_ten_minute(batch_limit integer DEFAULT 50000)
RETURNS TABLE (removed_rows integer, kept_rows integer, unfolded_rows bigint) LANGUAGE plpgsql AS $$
DECLARE
  removed integer := 0;
  kept integer := 0;
  extra bigint := 0;
BEGIN
  IF NOT pg_try_advisory_xact_lock(275817, 3) THEN
    RETURN QUERY SELECT 0, 0, 0::bigint;
    RETURN;
  END IF;

  WITH multi AS (
    SELECT workspace_id, region, kind, bucket
    FROM sending_metrics_ten_minute
    GROUP BY 1, 2, 3, 4
    HAVING count(*) > 1 OR bool_or(
      emails = 0 AND accepted = 0 AND delivered = 0 AND bounced = 0
      AND complained = 0 AND opened = 0 AND clicked = 0 AND failed = 0 AND delivery_delayed = 0 AND simulated = 0
    )
  ), picked AS (
    SELECT t.id
    FROM sending_metrics_ten_minute t
    JOIN multi m
      ON m.workspace_id = t.workspace_id AND m.region = t.region
     AND m.kind = t.kind AND m.bucket = t.bucket
    ORDER BY t.id
    LIMIT batch_limit
  ), gone AS (
    DELETE FROM sending_metrics_ten_minute t
    USING picked p
    WHERE t.id = p.id
    RETURNING t.workspace_id, t.region, t.kind, t.bucket,
      t.emails, t.accepted, t.delivered, t.bounced, t.complained,
      t.opened, t.clicked, t.failed, t.delivery_delayed, t.simulated
  ), folded AS (
    INSERT INTO sending_metrics_ten_minute (
      workspace_id, region, kind, bucket,
      emails, accepted, delivered, bounced, complained, opened, clicked, failed, delivery_delayed, simulated
    )
    SELECT workspace_id, region, kind, bucket,
      sum(emails), sum(accepted), sum(delivered), sum(bounced), sum(complained),
      sum(opened), sum(clicked), sum(failed), sum(delivery_delayed), sum(simulated)
    FROM gone
    GROUP BY 1, 2, 3, 4
    HAVING sum(emails) <> 0 OR sum(accepted) <> 0 OR sum(delivered) <> 0 OR sum(bounced) <> 0
        OR sum(complained) <> 0 OR sum(opened) <> 0 OR sum(clicked) <> 0 OR sum(failed) <> 0
        OR sum(delivery_delayed) <> 0 OR sum(simulated) <> 0
    RETURNING 1
  )
  SELECT (SELECT count(*)::int FROM gone), (SELECT count(*)::int FROM folded) INTO removed, kept;

  SELECT coalesce(sum(cnt - 1), 0)::bigint INTO extra
  FROM (
    SELECT count(*) AS cnt
    FROM sending_metrics_ten_minute
    GROUP BY workspace_id, region, kind, bucket
    HAVING count(*) > 1
  ) s;

  RETURN QUERY SELECT removed, kept, extra;
END $$;

CREATE FUNCTION reconcile_sending_metrics_ten_minute(wid text)
RETURNS TABLE (
  region text, kind text, bucket timestamptz,
  emails bigint, accepted bigint, delivered bigint, bounced bigint,
  complained bigint, opened bigint, clicked bigint, failed bigint, delivery_delayed bigint, simulated bigint
) LANGUAGE plpgsql SET plan_cache_mode = force_custom_plan AS $$
DECLARE
  cutoff timestamptz := date_bin('10 minutes', now() - interval '6 days', timestamptz '2000-01-01 00:00:00+00');
BEGIN
  PERFORM pg_advisory_xact_lock(275820, hashtext(wid));
  RETURN QUERY
  WITH diff AS (
    SELECT s.region, s.kind, s.bucket,
      sum(s.emails)::bigint AS emails, sum(s.accepted)::bigint AS accepted, sum(s.delivered)::bigint AS delivered,
      sum(s.bounced)::bigint AS bounced, sum(s.complained)::bigint AS complained, sum(s.opened)::bigint AS opened,
      sum(s.clicked)::bigint AS clicked, sum(s.failed)::bigint AS failed, sum(s.delivery_delayed)::bigint AS delivery_delayed,
      sum(s.simulated)::bigint AS simulated
    FROM (
      SELECT e.region, coalesce(e.snapshot->>'kind', '') AS kind,
        date_bin('10 minutes', e.created_at, timestamptz '2000-01-01 00:00:00+00') AS bucket,
        count(*)::bigint AS emails,
        count(*) FILTER (WHERE NOT e.simulated AND e.status <> 'suppressed' AND (e.provider_id IS NOT NULL OR e.status IN ('accepted','sent','delivered','bounced','complained','delayed') OR (e.event_outcomes & 1) <> 0))::bigint AS accepted,
        count(*) FILTER (WHERE e.status = 'delivered' OR (e.event_outcomes & 2) <> 0)::bigint AS delivered,
        count(*) FILTER (WHERE e.status = 'bounced' OR (e.event_outcomes & 4) <> 0)::bigint AS bounced,
        count(*) FILTER (WHERE e.status = 'complained' OR (e.event_outcomes & 8) <> 0)::bigint AS complained,
        count(*) FILTER (WHERE (e.event_outcomes & 16) <> 0)::bigint AS opened,
        count(*) FILTER (WHERE (e.event_outcomes & 32) <> 0)::bigint AS clicked,
        count(*) FILTER (WHERE e.status IN ('rejected','rendering_failed') OR (e.event_outcomes & 64) <> 0)::bigint AS failed,
        count(*) FILTER (WHERE e.status = 'delayed' OR (e.event_outcomes & 128) <> 0)::bigint AS delivery_delayed,
        count(*) FILTER (WHERE e.simulated)::bigint AS simulated
      FROM sending_emails e
      WHERE e.workspace_id = wid AND e.created_at >= cutoff
      GROUP BY 1, 2, 3
      UNION ALL
      SELECT t.region, t.kind, t.bucket,
        -t.emails, -t.accepted, -t.delivered, -t.bounced, -t.complained,
        -t.opened, -t.clicked, -t.failed, -t.delivery_delayed, -t.simulated
      FROM sending_metrics_ten_minute t
      WHERE t.workspace_id = wid AND t.bucket >= cutoff
    ) s
    GROUP BY 1, 2, 3
    HAVING sum(s.emails) <> 0 OR sum(s.accepted) <> 0 OR sum(s.delivered) <> 0 OR sum(s.bounced) <> 0
        OR sum(s.complained) <> 0 OR sum(s.opened) <> 0 OR sum(s.clicked) <> 0 OR sum(s.failed) <> 0
        OR sum(s.delivery_delayed) <> 0 OR sum(s.simulated) <> 0
  )
  INSERT INTO sending_metrics_ten_minute AS n (
    workspace_id, region, kind, bucket,
    emails, accepted, delivered, bounced, complained, opened, clicked, failed, delivery_delayed, simulated
  )
  SELECT wid, d.region, d.kind, d.bucket,
    d.emails, d.accepted, d.delivered, d.bounced, d.complained,
    d.opened, d.clicked, d.failed, d.delivery_delayed, d.simulated
  FROM diff d
  RETURNING n.region, n.kind, n.bucket, n.emails, n.accepted, n.delivered, n.bounced,
    n.complained, n.opened, n.clicked, n.failed, n.delivery_delayed, n.simulated;
END $$;
