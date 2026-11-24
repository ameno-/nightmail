-- Unify all per-workspace shared-row locks on sending_emails under strict lock DAG:
--   sending_emails row locks (id order) -> advisory 275820 (hashtext(wid) order) -> billing_meter_fence (wid order)
--   -> advisory 31403 (hashtext(wid) order) -> hourly table upserts (ordered).
-- Converts hosted_health_suppressed, hosted_adjust, and billing_adjust_sends to statement triggers (no temp tables,
-- zero locks when deltas are empty) and adds delayed > sent to sending_feedback_rank_guard so out-of-order Send
-- callbacks on the routine lane never regress delayed/soft-bounced status from the priority lane.
-- Locks ONLY sending_emails with a 2s lock_timeout retry loop.

CREATE OR REPLACE FUNCTION hosted_health_suppression_stmt() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  wids text[];
  eids text[];
BEGIN
  SELECT array_agg(workspace_id), array_agg(id)
  INTO wids, eids
  FROM (
    SELECT DISTINCT n.workspace_id, n.id
    FROM new_mail n
    JOIN old_mail o ON o.id = n.id
    WHERE NOT n.simulated AND (o.status = 'suppressed') <> (n.status = 'suppressed')
  ) s;

  IF wids IS NOT NULL THEN
    PERFORM hosted_refresh_health_batch(wids, eids);
  END IF;
  RETURN NULL;
END $$;

CREATE OR REPLACE FUNCTION billing_meter_sends() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  wids text[];
BEGIN
  SELECT array_agg(DISTINCT n.workspace_id ORDER BY n.workspace_id)
  INTO wids
  FROM new_mail n
  CROSS JOIN (SELECT bill_simulated FROM billing_config WHERE singleton) cfg
  WHERE (NOT n.simulated OR cfg.bill_simulated) AND hosted_charged(n.status, n.provider_id, n.error_code);

  IF wids IS NULL THEN RETURN NULL; END IF;

  PERFORM pg_advisory_xact_lock(275820, h) FROM (SELECT DISTINCT hashtext(w) AS h FROM unnest(wids) AS w ORDER BY 1) x;
  PERFORM billing_meter_fence(w) FROM unnest(wids) AS w;
  PERFORM pg_advisory_xact_lock(31403, h) FROM (SELECT DISTINCT hashtext(w) AS h FROM unnest(wids) AS w ORDER BY 1) x;

  INSERT INTO billing_usage_hourly AS u (workspace_id, hour, meter, rate_version, quantity)
  SELECT n.workspace_id, date_trunc('hour', n.created_at, 'UTC'),
         CASE WHEN (n.feedback_topic_arn IS NULL AND pc.kind = 'shared')
                OR EXISTS (SELECT FROM provider_pool_regions p WHERE p.feedback_topic_arn = n.feedback_topic_arn)
              THEN 'send' ELSE 'byo_send' END,
         1, sum(jsonb_array_length(n.to_addresses || n.cc_addresses || n.bcc_addresses))
  FROM new_mail n
  CROSS JOIN LATERAL (SELECT kind FROM provider_connections WHERE workspace_id = n.workspace_id ORDER BY kind LIMIT 1) pc
  CROSS JOIN (SELECT bill_simulated FROM billing_config WHERE singleton) cfg
  WHERE (NOT n.simulated OR cfg.bill_simulated) AND hosted_charged(n.status, n.provider_id, n.error_code)
  GROUP BY 1, 2, 3 ORDER BY 1, 2, 3
  ON CONFLICT (workspace_id, hour, meter, rate_version) DO UPDATE SET quantity = u.quantity + excluded.quantity;
  RETURN NULL;
END $$;

CREATE OR REPLACE FUNCTION hosted_charge_batch() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  u_wids text[];
  u_hours timestamptz[];
  u_rec bigint[];
  u_mkt bigint[];
BEGIN
  WITH agg AS (
    SELECT n.workspace_id, date_trunc('hour', n.created_at, 'UTC') AS hour,
      sum(jsonb_array_length(n.to_addresses || n.cc_addresses || n.bcc_addresses))::bigint AS rec,
      coalesce(sum(jsonb_array_length(n.to_addresses || n.cc_addresses || n.bcc_addresses))
        FILTER (WHERE n.snapshot->>'kind' = 'marketing' OR n.campaign_id IS NOT NULL OR n.snapshot ? 'bulk'), 0)::bigint AS mkt
    FROM new_mail n
    LEFT JOIN provider_connections pc USING (workspace_id)
    WHERE NOT n.simulated AND hosted_charged(n.status, n.provider_id)
      AND ((n.feedback_topic_arn IS NULL AND pc.kind = 'shared') OR n.feedback_topic_arn IN (SELECT feedback_topic_arn FROM provider_pool_regions))
    GROUP BY 1, 2
  )
  SELECT array_agg(workspace_id ORDER BY workspace_id, hour),
         array_agg(hour ORDER BY workspace_id, hour),
         array_agg(rec ORDER BY workspace_id, hour),
         array_agg(mkt ORDER BY workspace_id, hour)
  INTO u_wids, u_hours, u_rec, u_mkt
  FROM agg;

  IF u_wids IS NULL THEN RETURN NULL; END IF;

  PERFORM pg_advisory_xact_lock(275820, h)
  FROM (SELECT DISTINCT hashtext(wid) AS h FROM unnest(u_wids) AS wid ORDER BY 1) w;

  INSERT INTO hosted_usage_hourly AS u(workspace_id, hour, recipients, marketing)
  SELECT wid, hr, rec, mkt
  FROM unnest(u_wids, u_hours, u_rec, u_mkt) AS d(wid, hr, rec, mkt)
  ORDER BY wid, hr
  ON CONFLICT (workspace_id, hour) DO UPDATE
    SET recipients = u.recipients + excluded.recipients,
        marketing = u.marketing + excluded.marketing;
  RETURN NULL;
END $$;

CREATE OR REPLACE FUNCTION hosted_adjust_usage_stmt() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  u_wids text[];
  u_hours timestamptz[];
  u_rec bigint[];
  u_mkt bigint[];
BEGIN
  WITH changed AS (
    SELECT n.workspace_id, n.id, o.created_at AS old_at, n.created_at AS new_at,
      hosted_charged(o.status, o.provider_id, o.error_code)::int AS old_ch,
      hosted_charged(n.status, n.provider_id, n.error_code)::int AS new_ch,
      CASE WHEN n.charge_simulator
        THEN jsonb_array_length(n.to_addresses || n.cc_addresses || n.bcc_addresses)
        ELSE hosted_real_cost(n.to_addresses || n.cc_addresses || n.bcc_addresses) END AS cost,
      coalesce(n.snapshot->>'kind' = 'marketing' OR n.campaign_id IS NOT NULL OR n.snapshot ? 'bulk', false)::int AS mk
    FROM new_mail n
    JOIN old_mail o ON o.id = n.id
    LEFT JOIN provider_connections pc ON pc.workspace_id = n.workspace_id
    WHERE NOT n.simulated
      AND (hosted_charged(o.status, o.provider_id, o.error_code) <> hosted_charged(n.status, n.provider_id, n.error_code)
           OR o.created_at <> n.created_at)
      AND ((n.feedback_topic_arn IS NULL AND pc.kind = 'shared') OR EXISTS (
        SELECT FROM provider_feedback_history h WHERE h.topic_arn = n.feedback_topic_arn AND h.kind = 'shared'
      ))
  ),
  legs AS (
    SELECT workspace_id, date_trunc('hour', old_at, 'UTC') AS hour, (-cost * old_ch)::bigint AS delta, (-cost * old_ch * mk)::bigint AS mdelta FROM changed
    UNION ALL
    SELECT workspace_id, date_trunc('hour', new_at, 'UTC') AS hour, (cost * new_ch)::bigint AS delta, (cost * new_ch * mk)::bigint AS mdelta FROM changed
  ),
  agg AS (
    SELECT workspace_id, hour, sum(delta) AS rec, sum(mdelta) AS mkt
    FROM legs
    WHERE hour >= date_trunc('hour', now(), 'UTC') - interval '23 hours'
    GROUP BY 1, 2
    HAVING sum(delta) <> 0 OR sum(mdelta) <> 0
  )
  SELECT array_agg(workspace_id ORDER BY workspace_id, hour),
         array_agg(hour ORDER BY workspace_id, hour),
         array_agg(rec ORDER BY workspace_id, hour),
         array_agg(mkt ORDER BY workspace_id, hour)
  INTO u_wids, u_hours, u_rec, u_mkt
  FROM agg;

  IF u_wids IS NULL THEN RETURN NULL; END IF;

  PERFORM pg_advisory_xact_lock(275820, h)
  FROM (SELECT DISTINCT hashtext(wid) AS h FROM unnest(u_wids) AS wid ORDER BY 1) w;

  INSERT INTO hosted_usage_hourly AS u(workspace_id, hour, recipients, marketing)
  SELECT wid, hr, rec, mkt
  FROM unnest(u_wids, u_hours, u_rec, u_mkt) AS d(wid, hr, rec, mkt)
  ORDER BY wid, hr
  ON CONFLICT (workspace_id, hour) DO UPDATE
    SET recipients = u.recipients + excluded.recipients,
        marketing = u.marketing + excluded.marketing;
  RETURN NULL;
END $$;

CREATE OR REPLACE FUNCTION billing_adjust_sends_stmt() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  now_hour timestamptz := date_trunc('hour', now(), 'UTC');
  now_month timestamptz := date_trunc('month', now(), 'UTC');
  bill_sim boolean;
  b_wids text[];
  b_hours timestamptz[];
  b_meters text[];
  b_qtys bigint[];
  b_keys text[];
  i integer;
BEGIN
  SELECT bill_simulated INTO bill_sim FROM billing_config WHERE singleton;

  WITH raw AS (
    SELECT n.workspace_id, n.created_at,
      ((hosted_charged(n.status, n.provider_id, n.error_code)::int - hosted_charged(o.status, o.provider_id, o.error_code)::int)
        * jsonb_array_length(n.to_addresses || n.cc_addresses || n.bcc_addresses))::bigint AS d,
      CASE WHEN EXISTS (SELECT 1 FROM provider_pool_regions p WHERE p.feedback_topic_arn = n.feedback_topic_arn) THEN 'send'
        ELSE (SELECT CASE WHEN n.feedback_topic_arn IS NULL AND kind = 'shared' THEN 'send' ELSE 'byo_send' END
              FROM provider_connections WHERE workspace_id = n.workspace_id ORDER BY kind LIMIT 1) END AS m,
      CASE WHEN date_trunc('month', n.created_at, 'UTC') < now_month
        THEN (date_trunc('month', n.created_at AT TIME ZONE 'UTC') + interval '1 month' - interval '1 hour') AT TIME ZONE 'UTC'
        ELSE now_hour END AS h,
      date_trunc('month', n.created_at, 'UTC') < now_month AS earlier
    FROM new_mail n
    JOIN old_mail o ON o.id = n.id
    WHERE (NOT n.simulated OR coalesce(bill_sim, false))
      AND hosted_charged(o.status, o.provider_id, o.error_code) <> hosted_charged(n.status, n.provider_id, n.error_code)
  ),
  filtered AS (
    SELECT workspace_id, h, m, d,
      CASE WHEN d < 0 THEN (CASE WHEN h < now_hour THEN 's' ELSE '' END) || extract(epoch FROM date_trunc('hour', created_at, 'UTC'))::bigint::text END AS k
    FROM raw
    WHERE d <> 0 AND m IS NOT NULL AND NOT (d > 0 AND earlier)
  ),
  agg AS (
    SELECT workspace_id, h, m, k, sum(d) AS qty
    FROM filtered
    GROUP BY 1, 2, 3, 4
    HAVING sum(d) <> 0
  )
  SELECT array_agg(workspace_id ORDER BY workspace_id, h, m, k NULLS FIRST),
         array_agg(h ORDER BY workspace_id, h, m, k NULLS FIRST),
         array_agg(m ORDER BY workspace_id, h, m, k NULLS FIRST),
         array_agg(qty ORDER BY workspace_id, h, m, k NULLS FIRST),
         array_agg(k ORDER BY workspace_id, h, m, k NULLS FIRST)
  INTO b_wids, b_hours, b_meters, b_qtys, b_keys
  FROM agg;

  IF b_wids IS NULL THEN RETURN NULL; END IF;

  -- Lock 275820 (hashtext order) -> billing_meter_fence (wid order) -> 31403 (hashtext order).
  PERFORM pg_advisory_xact_lock(275820, h) FROM (SELECT DISTINCT hashtext(w) AS h FROM unnest(b_wids) AS w ORDER BY 1) x;
  PERFORM billing_meter_fence(w) FROM (SELECT DISTINCT w FROM unnest(b_wids) AS w ORDER BY 1) x;
  PERFORM pg_advisory_xact_lock(31403, h) FROM (SELECT DISTINCT hashtext(w) AS h FROM unnest(b_wids) AS w ORDER BY 1) x;

  FOR i IN 1..cardinality(b_wids) LOOP
    INSERT INTO billing_usage_hourly AS u (workspace_id, hour, meter, rate_version, quantity, settled_quantity, refunds)
      VALUES (b_wids[i], b_hours[i], b_meters[i], 1, b_qtys[i], 0,
        CASE WHEN b_qtys[i] < 0 THEN jsonb_build_object(b_keys[i], b_qtys[i]) ELSE '{}' END)
      ON CONFLICT (workspace_id, hour, meter, rate_version) DO UPDATE
        SET quantity = u.quantity + excluded.quantity,
            refunds = CASE WHEN excluded.quantity < 0
              THEN u.refunds || jsonb_build_object(b_keys[i], coalesce((u.refunds->>b_keys[i])::bigint, 0) + excluded.quantity)
              ELSE u.refunds END;
  END LOOP;
  RETURN NULL;
END $$;

-- Enforce delayed > sent (alongside migration 153's suppressed < delivered/bounced/complained) in the database so an
-- out-of-order Send arriving after a soft bounce or delivery delay can never regress status back to 'sent'.
CREATE OR REPLACE FUNCTION sending_feedback_rank_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = 'delayed' AND NEW.status = 'sent' THEN
    NEW.status := OLD.status;
  END IF;
  IF NEW.status='suppressed' AND NEW.suppression_reason='email_validation'
    AND OLD.status IN ('delivered','bounced','complained','rejected','rendering_failed','canceled','simulated') THEN
    NEW.status:=OLD.status; NEW.error_code:=OLD.error_code; NEW.suppression_reason:=OLD.suppression_reason;
  ELSIF NEW.error_code='EMAIL_VALIDATION_SUPPRESSED' AND OLD.error_code IS DISTINCT FROM 'EMAIL_VALIDATION_SUPPRESSED'
    AND (NEW.status<>'suppressed' OR OLD.error_code IS NOT NULL) THEN
    NEW.error_code:=OLD.error_code;
  ELSIF NEW.error_code='EMAIL_VALIDATION_SUPPRESSED' AND NEW.status<>'suppressed' THEN
    NEW.error_code:=NULL;
  END IF;
  RETURN NEW;
END $$;

DO $$
BEGIN
  FOR attempt IN 1..60 LOOP
    BEGIN
      SET LOCAL lock_timeout = '2s';
      LOCK TABLE sending_emails IN SHARE ROW EXCLUSIVE MODE;
      DROP TRIGGER IF EXISTS hosted_health_suppressed ON sending_emails;
      CREATE TRIGGER hosted_health_suppressed AFTER UPDATE ON sending_emails
        REFERENCING OLD TABLE AS old_mail NEW TABLE AS new_mail FOR EACH STATEMENT EXECUTE FUNCTION hosted_health_suppression_stmt();
      DROP TRIGGER IF EXISTS hosted_adjust ON sending_emails;
      CREATE TRIGGER hosted_adjust AFTER UPDATE ON sending_emails
        REFERENCING OLD TABLE AS old_mail NEW TABLE AS new_mail FOR EACH STATEMENT EXECUTE FUNCTION hosted_adjust_usage_stmt();
      DROP TRIGGER IF EXISTS billing_adjust_sends ON sending_emails;
      CREATE TRIGGER billing_adjust_sends AFTER UPDATE ON sending_emails
        REFERENCING OLD TABLE AS old_mail NEW TABLE AS new_mail FOR EACH STATEMENT EXECUTE FUNCTION billing_adjust_sends_stmt();
      DROP TRIGGER IF EXISTS sending_feedback_rank_guard ON sending_emails;
      CREATE TRIGGER sending_feedback_rank_guard BEFORE UPDATE ON sending_emails FOR EACH ROW
        WHEN (OLD.status IN ('suppressed','delayed') OR NEW.status='suppressed' OR NEW.error_code='EMAIL_VALIDATION_SUPPRESSED')
        EXECUTE FUNCTION sending_feedback_rank_guard();
      RETURN;
    EXCEPTION WHEN lock_not_available THEN
      PERFORM pg_sleep(1);
    END;
  END LOOP;
  RAISE EXCEPTION 'sending_emails was busy for 3 minutes. Nothing was changed: run the migration again.' USING ERRCODE = 'lock_not_available';
END $$;
