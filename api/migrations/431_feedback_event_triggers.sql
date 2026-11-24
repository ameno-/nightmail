-- Convert hosted_health_feedback from a per-row trigger to an ordered statement trigger on sending_email_events,
-- taking per-workspace advisory lock 275820 in strict hashtext(workspace_id) order ONLY for workspaces with non-zero
-- deltas. Preserves all 6 health columns from migration 231 (accepted, bounces, complaints + marketing_*).
-- Inlines the hosted_health_projection query directly over pairs so Postgres uses index lookups on sending_emails and
-- sending_email_events instead of materializing the window-function view across the full table.
-- Locks ONLY sending_email_events (432 handles sending_emails in its own transaction) with a 2s lock_timeout retry loop.

CREATE OR REPLACE FUNCTION hosted_refresh_health_batch(wids text[], eids text[]) RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  d_wids text[];
  d_epochs timestamptz[];
  d_hours timestamptz[];
  d_a bigint[];
  d_b bigint[];
  d_c bigint[];
  d_ma bigint[];
  d_mb bigint[];
  d_mc bigint[];
BEGIN
  IF wids IS NULL OR cardinality(wids) = 0 THEN RETURN; END IF;

  WITH pairs AS MATERIALIZED (
    SELECT DISTINCT p.wid AS workspace_id, p.eid AS email_id, coalesce(pc.resumed_at, '-infinity') AS epoch
    FROM unnest(wids, eids) AS p(wid, eid)
    JOIN provider_connections pc ON pc.workspace_id = p.wid AND pc.kind = 'shared'
  ),
  envelopes AS MATERIALIZED (
    SELECT p.workspace_id, p.email_id, p.epoch,
      hosted_real_cost(e.to_addresses || e.cc_addresses || e.bcc_addresses) AS cost,
      coalesce(e.snapshot->>'kind' = 'marketing' OR e.campaign_id IS NOT NULL OR e.snapshot ? 'bulk', false) AS marketing
    FROM pairs p
    JOIN sending_emails e ON e.workspace_id = p.workspace_id AND e.id = p.email_id
    WHERE NOT e.simulated AND e.status <> 'suppressed'
      AND (e.feedback_topic_arn IS NULL OR EXISTS (
        SELECT FROM provider_feedback_history h WHERE h.topic_arn = e.feedback_topic_arn AND h.kind = 'shared'
      ))
  ),
  latest AS (
    SELECT v.workspace_id, v.email_id, e.epoch, e.cost,
      CASE WHEN v.type IN ('accepted', 'send') THEN 'accepted' ELSE v.type END AS kind,
      coalesce(h.hash, '') AS dest, max(v.created_at) AS at, bool_or(e.marketing) AS marketing
    FROM envelopes e
    JOIN sending_email_events v ON v.workspace_id = e.workspace_id AND v.email_id = e.email_id
    LEFT JOIN LATERAL unnest(v.recipient_hashes) h(hash) ON v.type IN ('bounce', 'complaint')
    WHERE NOT v.simulated AND e.cost > 0 AND v.created_at > e.epoch
      AND v.created_at >= date_trunc('hour', now(), 'UTC') - interval '47 hours'
      AND (v.type IN ('accepted', 'send', 'complaint') OR (v.type = 'bounce' AND v.data->>'bounceType' = 'Permanent'))
      AND (v.recipient_hashes IS NULL OR cardinality(v.recipient_hashes) > 0)
    GROUP BY 1, 2, 3, 4, 5, 6
  ),
  ranked AS (
    SELECT *, row_number() OVER (PARTITION BY workspace_id, email_id, kind ORDER BY (dest <> '') DESC, at DESC, dest) AS pos,
      max(at) FILTER (WHERE dest = '') OVER (PARTITION BY workspace_id, email_id, kind) AS unknown_at
    FROM latest
  ),
  counted AS (
    SELECT workspace_id, email_id, epoch,
      date_trunc('hour', CASE WHEN pos = 1 THEN greatest(at, unknown_at) ELSE at END, 'UTC') AS hour,
      coalesce(sum(cost) FILTER (WHERE kind = 'accepted'), 0)::int AS accepted,
      count(*) FILTER (WHERE kind = 'bounce')::int AS bounces,
      count(*) FILTER (WHERE kind = 'complaint')::int AS complaints,
      bool_or(marketing) AS marketing
    FROM ranked
    WHERE dest <> '' OR pos = 1
    GROUP BY 1, 2, 3, 4
  ),
  wanted AS MATERIALIZED (
    SELECT workspace_id, email_id, epoch, hour, accepted, bounces, complaints,
      CASE WHEN marketing THEN accepted ELSE 0 END AS marketing_accepted,
      CASE WHEN marketing THEN bounces ELSE 0 END AS marketing_bounces,
      CASE WHEN marketing THEN complaints ELSE 0 END AS marketing_complaints
    FROM counted
  ),
  old AS MATERIALIZED (
    SELECT c.workspace_id, c.email_id, c.epoch, c.hour,
      c.accepted, c.bounces, c.complaints, c.marketing_accepted, c.marketing_bounces, c.marketing_complaints
    FROM pairs p
    JOIN hosted_health_credits c ON c.workspace_id = p.workspace_id AND c.email_id = p.email_id
  ),
  removed AS (
    DELETE FROM hosted_health_credits c
    USING pairs p
    WHERE c.workspace_id = p.workspace_id AND c.email_id = p.email_id
      AND NOT EXISTS (
        SELECT 1 FROM wanted w
        WHERE w.workspace_id = c.workspace_id AND w.email_id = c.email_id AND w.epoch = c.epoch AND w.hour = c.hour
      )
    RETURNING c.workspace_id, c.epoch, c.hour,
      -c.accepted::bigint AS a, -c.bounces::bigint AS b, -c.complaints::bigint AS c,
      -c.marketing_accepted::bigint AS ma, -c.marketing_bounces::bigint AS mb, -c.marketing_complaints::bigint AS mc
  ),
  changed AS (
    INSERT INTO hosted_health_credits AS c (workspace_id, email_id, epoch, hour, accepted, bounces, complaints, marketing_accepted, marketing_bounces, marketing_complaints)
    SELECT workspace_id, email_id, epoch, hour, accepted, bounces, complaints, marketing_accepted, marketing_bounces, marketing_complaints
    FROM wanted
    ORDER BY workspace_id, email_id, epoch, hour
    ON CONFLICT (workspace_id, email_id, epoch, hour) DO UPDATE
      SET accepted = excluded.accepted, bounces = excluded.bounces, complaints = excluded.complaints,
          marketing_accepted = excluded.marketing_accepted, marketing_bounces = excluded.marketing_bounces, marketing_complaints = excluded.marketing_complaints
      WHERE (c.accepted, c.bounces, c.complaints, c.marketing_accepted, c.marketing_bounces, c.marketing_complaints)
         <> (excluded.accepted, excluded.bounces, excluded.complaints, excluded.marketing_accepted, excluded.marketing_bounces, excluded.marketing_complaints)
    RETURNING c.workspace_id, c.email_id, c.epoch, c.hour,
      c.accepted, c.bounces, c.complaints, c.marketing_accepted, c.marketing_bounces, c.marketing_complaints
  ),
  raw_deltas AS (
    SELECT workspace_id, epoch, hour, a, b, c, ma, mb, mc FROM removed
    UNION ALL
    SELECT n.workspace_id, n.epoch, n.hour,
      (n.accepted - coalesce(o.accepted, 0))::bigint,
      (n.bounces - coalesce(o.bounces, 0))::bigint,
      (n.complaints - coalesce(o.complaints, 0))::bigint,
      (n.marketing_accepted - coalesce(o.marketing_accepted, 0))::bigint,
      (n.marketing_bounces - coalesce(o.marketing_bounces, 0))::bigint,
      (n.marketing_complaints - coalesce(o.marketing_complaints, 0))::bigint
    FROM changed n LEFT JOIN old o USING (workspace_id, email_id, epoch, hour)
  ),
  agg AS (
    SELECT workspace_id, epoch, hour,
      sum(a) AS a, sum(b) AS b, sum(c) AS c,
      sum(ma) AS ma, sum(mb) AS mb, sum(mc) AS mc
    FROM raw_deltas
    GROUP BY 1, 2, 3
    HAVING sum(a) <> 0 OR sum(b) <> 0 OR sum(c) <> 0 OR sum(ma) <> 0 OR sum(mb) <> 0 OR sum(mc) <> 0
  )
  SELECT array_agg(workspace_id ORDER BY workspace_id, epoch, hour),
         array_agg(epoch ORDER BY workspace_id, epoch, hour),
         array_agg(hour ORDER BY workspace_id, epoch, hour),
         array_agg(a ORDER BY workspace_id, epoch, hour),
         array_agg(b ORDER BY workspace_id, epoch, hour),
         array_agg(c ORDER BY workspace_id, epoch, hour),
         array_agg(ma ORDER BY workspace_id, epoch, hour),
         array_agg(mb ORDER BY workspace_id, epoch, hour),
         array_agg(mc ORDER BY workspace_id, epoch, hour)
  INTO d_wids, d_epochs, d_hours, d_a, d_b, d_c, d_ma, d_mb, d_mc
  FROM agg;

  IF d_wids IS NULL THEN RETURN; END IF;

  -- Acquire per-workspace shared-row advisory lock 275820 in strict hashtext order ONLY when deltas exist.
  PERFORM pg_advisory_xact_lock(275820, h)
  FROM (SELECT DISTINCT hashtext(wid) AS h FROM unnest(d_wids) AS wid ORDER BY 1) w;

  INSERT INTO hosted_health_hourly AS totals (workspace_id, epoch, hour, accepted, bounces, complaints, marketing_accepted, marketing_bounces, marketing_complaints)
  SELECT wid, ep, hr, a, b, c, ma, mb, mc
  FROM unnest(d_wids, d_epochs, d_hours, d_a, d_b, d_c, d_ma, d_mb, d_mc) AS d(wid, ep, hr, a, b, c, ma, mb, mc)
  ORDER BY wid, ep, hr
  ON CONFLICT (workspace_id, epoch, hour) DO UPDATE
    SET accepted = totals.accepted + excluded.accepted,
        bounces = totals.bounces + excluded.bounces,
        complaints = totals.complaints + excluded.complaints,
        marketing_accepted = totals.marketing_accepted + excluded.marketing_accepted,
        marketing_bounces = totals.marketing_bounces + excluded.marketing_bounces,
        marketing_complaints = totals.marketing_complaints + excluded.marketing_complaints;
END $$;

CREATE OR REPLACE FUNCTION hosted_refresh_health(wid text, eid text) RETURNS void LANGUAGE sql AS $$
  SELECT hosted_refresh_health_batch(ARRAY[wid], ARRAY[eid])
$$;

CREATE OR REPLACE FUNCTION hosted_health_events_stmt() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  wids text[];
  eids text[];
BEGIN
  SELECT array_agg(workspace_id), array_agg(email_id)
  INTO wids, eids
  FROM (
    SELECT DISTINCT n.workspace_id, n.email_id
    FROM new_events n
    WHERE NOT n.simulated
      AND (n.type IN ('accepted','send','complaint') OR (n.type = 'bounce' AND n.data->>'bounceType' = 'Permanent'))
  ) s;

  IF wids IS NOT NULL THEN
    PERFORM hosted_refresh_health_batch(wids, eids);
  END IF;
  RETURN NULL;
END $$;

DO $$
BEGIN
  FOR attempt IN 1..60 LOOP
    BEGIN
      SET LOCAL lock_timeout = '2s';
      LOCK TABLE sending_email_events IN SHARE ROW EXCLUSIVE MODE;
      DROP TRIGGER IF EXISTS hosted_health_feedback ON sending_email_events;
      CREATE TRIGGER hosted_health_feedback AFTER INSERT ON sending_email_events
        REFERENCING NEW TABLE AS new_events FOR EACH STATEMENT EXECUTE FUNCTION hosted_health_events_stmt();
      RETURN;
    EXCEPTION WHEN lock_not_available THEN
      PERFORM pg_sleep(1);
    END;
  END LOOP;
  RAISE EXCEPTION 'sending_email_events was busy for 3 minutes. Nothing was changed: run the migration again.' USING ERRCODE = 'lock_not_available';
END $$;
