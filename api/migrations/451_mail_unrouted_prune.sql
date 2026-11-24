SET LOCAL lock_timeout='2s';

-- Deletes up to batch_size (max 1,000) oldest mail_unrouted rows past 30 days, and removes any
-- resulting unreferenced mail_messages (plus queues mail.deleteObjects for R2/local raw .eml and
-- attachments — leaving S3 objects to the bucket's own lifecycle — and cleans up empty mail_threads).
-- Acquires the workspace ingest lane first, then
-- deletes locked rows and checks mailbox_messages / remaining mail_unrouted in a separate statement
-- so mail claimed moments before (or delivered to another inbox) is never deleted.
CREATE OR REPLACE FUNCTION mail_unrouted_prune_batch(batch_size integer DEFAULT 1000) RETURNS integer LANGUAGE plpgsql AS $$
DECLARE n int; wids text[]; mids text[]; threads text[];
BEGIN
  SELECT ARRAY(
    SELECT DISTINCT workspace_id FROM (
      SELECT workspace_id FROM mail_unrouted
      WHERE created_at < now() - interval '30 days'
      ORDER BY created_at LIMIT least(greatest(batch_size, 1), 1000)
    ) c ORDER BY workspace_id
  ) INTO wids;
  IF coalesce(cardinality(wids), 0) = 0 THEN RETURN 0; END IF;
  INSERT INTO mailbox_write_lanes(workspace_id, lane)
  SELECT w, 'ingest' FROM unnest(wids) w ORDER BY w
  ON CONFLICT(workspace_id, lane) DO UPDATE SET lane = excluded.lane WHERE false;

  WITH picked AS MATERIALIZED (
    SELECT workspace_id, address, message_id
    FROM mail_unrouted
    WHERE created_at < now() - interval '30 days'
      AND workspace_id = ANY(wids)
    ORDER BY created_at
    LIMIT least(greatest(batch_size, 1), 1000)
    FOR UPDATE SKIP LOCKED
  ),
  gone AS (
    DELETE FROM mail_unrouted u USING picked p
    WHERE u.workspace_id = p.workspace_id AND u.address = p.address AND u.message_id = p.message_id
    RETURNING u.message_id
  )
  SELECT count(*)::int, ARRAY(SELECT DISTINCT message_id FROM gone) INTO n, mids FROM gone;

  IF coalesce(cardinality(mids), 0) > 0 THEN
    WITH dead AS MATERIALIZED (
      SELECT m.* FROM mail_messages m
      WHERE m.id = ANY(mids) AND m.workspace_id = ANY(wids)
        AND NOT EXISTS (SELECT 1 FROM mailbox_messages mm WHERE mm.message_id = m.id)
        AND NOT EXISTS (SELECT 1 FROM mail_unrouted rem WHERE rem.message_id = m.id)
      ORDER BY m.id
      FOR UPDATE OF m
    ),
    keys AS (
      SELECT workspace_id, region, raw_bucket AS bucket, raw_key AS key
      FROM dead WHERE raw_bucket IS NOT NULL AND raw_key IS NOT NULL
      UNION ALL
      SELECT d.workspace_id, d.region, a.bucket, a.storage_key
      FROM dead d JOIN mail_attachments a ON a.message_id = d.id AND a.workspace_id = d.workspace_id
    ),
    chunks AS (
      SELECT *, (row_number() OVER (PARTITION BY workspace_id, bucket, region ORDER BY key) - 1) / 1000 AS chunk
      FROM keys WHERE strpos(bucket, ':') > 0
    ),
    queued AS (
      INSERT INTO jobs(id, type, workspace_id, payload)
      SELECT row_id('job'), 'mail.deleteObjects', workspace_id,
             jsonb_build_object('region', region, 'bucket', bucket, 'keys', jsonb_agg(key))
      FROM chunks GROUP BY workspace_id, bucket, region, chunk
    ),
    expired AS (
      DELETE FROM mail_messages m USING dead d WHERE m.id = d.id RETURNING m.thread_id
    )
    SELECT ARRAY(SELECT DISTINCT thread_id FROM expired) INTO threads;

    IF coalesce(cardinality(threads), 0) > 0 THEN
      DELETE FROM mail_threads t WHERE id = ANY(threads) AND NOT EXISTS (SELECT 1 FROM mail_messages m WHERE m.thread_id = t.id);
    END IF;
  END IF;

  RETURN coalesce(n, 0);
END $$;
