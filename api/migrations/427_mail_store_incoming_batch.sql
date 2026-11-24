SET LOCAL lock_timeout='2s';

-- Batched byte-budget reservation for a workspace's claimed ingest batch: takes mail_receive_windows
-- FOR UPDATE once, evaluates billing_position once, locks pending receipts in ses_message_id order,
-- and debits cumulative bytes with the exact same continuous-refill math as single-message ingest.
DROP FUNCTION IF EXISTS mail_reserve_ingest_batch(text, jsonb, boolean);
CREATE OR REPLACE FUNCTION mail_reserve_ingest_batch(wid text, items jsonb, check_billing boolean DEFAULT false)
RETURNS TABLE(ses_message_id text, pending boolean, ok boolean, fits boolean, due text, receive_held boolean)
LANGUAGE plpgsql VOLATILE AS $$
DECLARE
  pol record;
  win record;
  rec record;
  item record;
  cur_level double precision;
  cur_msgs double precision;
  cur_window timestamptz := date_trunc('hour', now());
  cur_ts timestamptz := now();
  win_bytes bigint := 0;
  win_msgs int := 0;
  has_win boolean := false;
  held boolean := false;
  item_pending boolean;
  item_ok boolean;
  item_fits boolean;
  item_due text;
  item_size bigint;
  new_level double precision;
BEGIN
  -- Lock order matches single-message ingest and route statements (157): window row before receipts.
  SELECT messages, bytes INTO pol FROM mail_receive_policy(wid);
  SELECT w.window_at, w.messages, w.bytes, w.level_at, w.message_level, w.byte_level
    INTO win FROM mail_receive_windows w WHERE w.workspace_id = wid FOR UPDATE;
  IF FOUND THEN
    has_win := true;
    cur_level := mail_receive_level(win.byte_level, win.level_at, pol.bytes);
    cur_msgs := mail_receive_level(win.message_level, win.level_at, pol.messages);
    IF win.window_at = cur_window THEN
      win_bytes := win.bytes;
      win_msgs := win.messages;
    END IF;
    cur_ts := greatest(win.level_at, cur_ts);
  ELSE
    cur_level := 0;
    cur_msgs := 0;
  END IF;

  IF check_billing THEN
    held := coalesce((billing_position(wid)->>'receiveHeld')::boolean, false);
  END IF;

  -- Lock all pending receipts for this batch in ses_message_id order before mutating.
  PERFORM 1 FROM mail_receipts r
    WHERE r.workspace_id = wid
      AND r.ses_message_id IN (SELECT x->>'ses_message_id' FROM jsonb_array_elements(items) x)
      AND r.status = 'pending'
    ORDER BY r.ses_message_id
    FOR UPDATE;

  FOR item IN
    SELECT x->>'ses_message_id' AS mid,
           (x->>'size')::bigint AS sz,
           x->>'candidate_batch' AS c_batch,
           x->>'candidate_bucket' AS c_bucket,
           x->>'candidate_region' AS c_region,
           x->>'candidate_message_id' AS c_mid,
           x->>'candidate_key' AS c_key
    FROM jsonb_array_elements(items) x
    ORDER BY x->>'ses_message_id'
  LOOP
    item_pending := false;
    item_ok := false;
    item_fits := false;
    item_due := NULL;
    item_size := item.sz;

    SELECT r.reserved_bytes INTO rec
      FROM mail_receipts r
      WHERE r.workspace_id = wid AND r.ses_message_id = item.mid AND r.status = 'pending';

    IF FOUND THEN
      item_pending := true;
      IF item.c_batch IS NOT NULL THEN
        INSERT INTO mail_candidate_uploads(batch, workspace_id, ses_message_id, bucket, region, message_id, keys)
        VALUES (item.c_batch, wid, item.mid, item.c_bucket, item.c_region, item.c_mid, ARRAY[item.c_key])
        ON CONFLICT (batch) DO UPDATE SET check_at = now() + interval '1 hour';
      END IF;

      IF rec.reserved_bytes = item_size THEN
        item_ok := true;
      ELSIF rec.reserved_bytes IS NULL THEN
        item_fits := (item_size <= pol.bytes);
        IF item_fits AND (cur_level + item_size) <= (pol.bytes::double precision * 1.25) THEN
          new_level := cur_level + item_size;
          cur_level := new_level;
          win_bytes := win_bytes + item_size;
          has_win := true;
          UPDATE mail_receipts r SET reserved_bytes = item_size
            WHERE r.workspace_id = wid AND r.ses_message_id = item.mid AND r.status = 'pending';
          item_ok := true;
          IF new_level > pol.bytes THEN
            item_due := to_char((now() + make_interval(secs => (new_level - pol.bytes) * 3600.0 / pol.bytes)) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
          END IF;
        END IF;
      END IF;
    END IF;

    ses_message_id := item.mid;
    pending := item_pending;
    ok := item_ok;
    fits := item_fits;
    due := item_due;
    receive_held := held;
    RETURN NEXT;
  END LOOP;

  IF has_win THEN
    INSERT INTO mail_receive_windows(workspace_id, window_at, messages, bytes, level_at, message_level, byte_level)
    VALUES (wid, cur_window, win_msgs, win_bytes, cur_ts, cur_msgs, cur_level)
    ON CONFLICT (workspace_id) DO UPDATE SET
      window_at = excluded.window_at,
      messages = excluded.messages,
      bytes = excluded.bytes,
      level_at = excluded.level_at,
      message_level = excluded.message_level,
      byte_level = excluded.byte_level;
  END IF;
END $$;

-- Set-based batched inbound store for one workspace. Acquires mailbox_write_lanes(wid, 'ingest') once.
-- When every item in the batch satisfies the direct-delivery fast-path preconditions (verified post-lock),
-- stores all items in one set-based SQL pass (1 mail_threads/mailbox_threads/inbox_state/inbox_folders
-- update per target instead of N, 1 billing_meter_mail trigger firing, 1 events lane acquisition).
-- Any edge case (attachments, spam, quota boundary, catch-all auto-create, ephemeral, reopened receipt,
-- duplicate Message-ID, intra-batch reply chain, DMARC unverified, ritual grants/webhooks, bounce
-- un-suppression) falls back sequentially to mail_store_incoming() inside the same transaction.
CREATE OR REPLACE FUNCTION mail_store_incoming_batch(wid text, items jsonb, policy jsonb DEFAULT NULL)
RETURNS TABLE(ses_message_id text, queued_count integer, wait_ms double precision, hold_ms double precision)
LANGUAGE plpgsql VOLATILE AS $$
DECLARE
  n_items int := coalesce(jsonb_array_length(items), 0);
  started timestamptz := clock_timestamp();
  locked timestamptz;
  fast_ok boolean := false;
  q_count int := 0;
  w_ms double precision;
  h_ms double precision;
  rec record;
  res record;
  bid text;
BEGIN
  IF n_items = 0 THEN RETURN; END IF;

  INSERT INTO mailbox_write_lanes(workspace_id, lane) VALUES(wid, 'ingest')
    ON CONFLICT(workspace_id, lane) DO UPDATE SET lane = excluded.lane WHERE false;
  locked := clock_timestamp();

  -- Fast-path structural precheck on the batch payload before touching tables.
  IF n_items >= 2 AND NOT EXISTS (
    SELECT 1 FROM jsonb_array_elements(items) e
    WHERE coalesce(jsonb_array_length(e->'files'), 0) > 0
       OR (e->'msg'->>'workspace_id') IS DISTINCT FROM wid
       OR coalesce(e->'msg'->>'lifecycle', 'default') NOT IN ('default', 'kept')
       OR coalesce(e->'msg'#>>'{verdicts,simulated}', '') = 'true'
       OR coalesce(jsonb_array_length(e->'envelopes'), 0) <> 1
       OR coalesce((e->'msg'->>'spam')::boolean, false)
       OR (e->'plan' IS NOT NULL AND jsonb_typeof(e->'plan') <> 'null' AND (
            coalesce(jsonb_array_length(e->'plan'->'grants'), 0) > 0
         OR coalesce(jsonb_array_length(e->'plan'->'recipients'), 0) <> 1
         OR coalesce((e->'plan'#>'{recipients,0,dropped}')::boolean, false)
         OR coalesce((e->'plan'#>'{recipients,0,limited}')::boolean, false)
         OR coalesce((e->'plan'#>'{recipients,0,junk}')::boolean, false)
         OR coalesce(jsonb_array_length(e->'plan'#>'{recipients,0,webhooks}'), 0) > 0
         OR coalesce(jsonb_array_length(e->'plan'#>'{recipients,0,inboxes}'), 0) <> 1
         OR coalesce(jsonb_array_length(e->'plan'#>'{recipients,0,labels}'), 0) > 0
         OR coalesce(jsonb_array_length(e->'plan'#>'{recipients,0,added}'), 0) > 0
       ))
  ) THEN
    -- Verify post-lock database preconditions using a transaction-local temp table for resolved items.
    CREATE TEMP TABLE IF NOT EXISTS _batch_ing (
      ord int NOT NULL,
      mid text NOT NULL,
      ses_id text NOT NULL,
      msg_id text,
      received_at timestamptz NOT NULL,
      size_bytes int NOT NULL,
      lifecycle text NOT NULL,
      dmarc text,
      addr text NOT NULL,
      mailbox_id text NOT NULL,
      thread_id text,
      delivery_seq bigint,
      new_modseq bigint,
      new_uid bigint,
      msg jsonb NOT NULL,
      refs jsonb NOT NULL,
      plan jsonb,
      prefix text,
      complete boolean NOT NULL
    ) ON COMMIT DELETE ROWS;
    DELETE FROM _batch_ing;

    -- Lock pending receipts in ses_message_id order and verify exact count & recipients match.
    PERFORM 1 FROM mail_receipts r
      WHERE r.workspace_id = wid
        AND r.ses_message_id IN (SELECT e->'msg'->>'ses_message_id' FROM jsonb_array_elements(items) e)
        AND r.status = 'pending'
      ORDER BY r.ses_message_id
      FOR UPDATE;

    -- Resolve every item's single recipient to a live, non-expired, non-ended, non-public inbox.
    INSERT INTO _batch_ing(ord, mid, ses_id, msg_id, received_at, size_bytes, lifecycle, dmarc, addr, mailbox_id, msg, refs, plan, prefix, complete)
    WITH raw_items AS (
      SELECT ord::int AS ord,
             e->'msg' AS msg,
             coalesce(e->'refs', '[]'::jsonb) AS refs,
             CASE WHEN e->'plan' IS NOT NULL AND jsonb_typeof(e->'plan') <> 'null' THEN e->'plan' END AS plan,
             e->'envelopes'->0->>'addr' AS addr,
             regexp_replace(e->'envelopes'->0->>'addr', '[+][^@]*@', '@') AS base,
             e->>'prefix' AS prefix,
             coalesce((e->>'complete')::boolean, false) AS complete
      FROM jsonb_array_elements(items) WITH ORDINALITY t(e, ord)
    ),
    checked AS (
      SELECT i.*,
             r.ses_message_id AS live_receipt,
             d.id AS dom_id,
             o.mailbox_id AS resolved_box,
             o.require_dmarc,
             o.retention_mode,
             o.expires_at,
             o.delete_after,
             o.valid_owner
      FROM raw_items i
      JOIN mail_receipts r
        ON r.workspace_id = wid
       AND r.ses_message_id = i.msg->>'ses_message_id'
       AND r.status = 'pending'
       AND r.recipients = i.msg->'envelope_to'
      JOIN mailbox_domains d
        ON d.workspace_id = wid
       AND coalesce(d.receiving_host, d.name) = split_part(i.addr, '@', 2)
       AND (d.status = 'active' OR (d.receiving_host IS NULL AND d.status IN ('waiting_for_mx', 'provisioning')))
      JOIN LATERAL (
        SELECT b.id AS mailbox_id, b.require_dmarc, b.retention_mode, b.expires_at, b.delete_after,
               CASE
                 WHEN i.plan IS NULL THEN true
                 WHEN i.plan#>'{recipients,0}'->>'route' IS NULL AND i.plan#>'{recipients,0}'->>'tier' IN ('address', 'subaddress')
                   THEN EXISTS(SELECT 1 FROM mailbox_addresses oa WHERE oa.workspace_id = wid AND oa.mailbox_id = b.id AND oa.address IN (i.addr, i.base))
                 ELSE true
               END AS valid_owner
        FROM (
          SELECT CASE
                   WHEN i.plan IS NOT NULL THEN i.plan#>'{recipients,0,inboxes}'->>0
                   ELSE (
                     SELECT a.mailbox_id FROM mailbox_addresses a
                     JOIN mailboxes mb ON mb.id = a.mailbox_id
                     WHERE a.workspace_id = wid AND a.kind <> 'public'
                       AND (mb.delete_after IS NULL OR mb.delete_after > statement_timestamp())
                       AND a.address IN (i.addr, i.base)
                     ORDER BY (a.address = i.addr) DESC LIMIT 1
                   )
                 END AS target_id
        ) pick
        JOIN mailboxes b ON b.workspace_id = wid AND b.id = pick.target_id
        WHERE (b.delete_after IS NULL OR b.delete_after > statement_timestamp())
          AND b.expires_at IS NULL
      ) o ON true
      WHERE o.valid_owner
        AND NOT (o.require_dmarc AND (i.msg#>>'{verdicts,dmarc}') IS DISTINCT FROM 'PASS')
        AND NOT (o.retention_mode = 'forever' AND coalesce(i.msg->>'lifecycle', 'default') <> 'kept')
        AND NOT EXISTS (
          SELECT 1 FROM mail_retired_addresses rt
          WHERE rt.workspace_id = wid AND rt.address IN (i.addr, i.base) AND rt.until > now() AND rt.address LIKE '%.sandbox.invalid'
        )
        AND NOT EXISTS (
          SELECT 1 FROM mailbox_addresses pa WHERE pa.workspace_id = wid AND pa.address IN (i.addr, i.base) AND pa.kind = 'public'
        )
        AND NOT EXISTS (
          SELECT 1 FROM mailbox_addresses ea JOIN mailboxes eb ON eb.id = ea.mailbox_id
          WHERE ea.workspace_id = wid AND ea.address IN (i.addr, i.base) AND eb.delete_after <= statement_timestamp() AND NOT ea.address LIKE '%.sandbox.invalid'
        )
    )
    SELECT c.ord,
           c.msg->>'id',
           c.msg->>'ses_message_id',
           nullif(c.msg->>'message_id', ''),
           (c.msg->>'received_at')::timestamptz,
           coalesce((c.msg->>'size_bytes')::int, 0),
           coalesce(c.msg->>'lifecycle', 'default'),
           c.msg#>>'{verdicts,dmarc}',
           c.addr,
           c.resolved_box,
           c.msg,
           c.refs,
           c.plan,
           c.prefix,
           c.complete
    FROM checked c;

    IF (SELECT count(*) FROM _batch_ing) = n_items
       AND (SELECT count(DISTINCT ses_id) FROM _batch_ing) = n_items
       AND (SELECT count(DISTINCT mid) FROM _batch_ing) = n_items
       AND NOT EXISTS (SELECT 1 FROM _batch_ing b JOIN mail_messages m ON m.id = b.mid)
       AND NOT EXISTS (SELECT 1 FROM _batch_ing b JOIN mail_message_ids i ON i.workspace_id = wid AND i.message_id = b.msg_id WHERE b.msg_id IS NOT NULL)
       AND (SELECT count(DISTINCT msg_id) FROM _batch_ing WHERE msg_id IS NOT NULL) = (SELECT count(*) FROM _batch_ing WHERE msg_id IS NOT NULL)
       AND NOT EXISTS (
         SELECT 1 FROM _batch_ing b1
         CROSS JOIN jsonb_array_elements_text(b1.refs) ref(val)
         JOIN _batch_ing b2 ON b2.msg_id = ref.val AND b2.ord <> b1.ord
       )
       AND NOT EXISTS (
         SELECT 1 FROM _batch_ing b JOIN inbox_vanished v ON v.inbox_id = b.mailbox_id AND v.message_id = b.mid
       )
       AND NOT EXISTS (
         SELECT 1 FROM _batch_ing b JOIN audience_contacts c ON c.workspace_id = wid AND c.email = b.msg->>'from_address'
         WHERE c.suppressed AND c.suppression_reason IN ('hard_bounce', 'soft_bounce', 'transient', 'email_validation') AND c.marketing_consent <> 'unsubscribed'
       )
    THEN
      -- Lock all target inbox_state rows in deterministic inbox_id order and verify quota headroom for the whole batch.
      IF NOT EXISTS (
        WITH need AS (
          SELECT b.mailbox_id, count(*)::int AS add_msgs, sum(b.size_bytes)::bigint AS add_bytes
          FROM _batch_ing b GROUP BY b.mailbox_id
        ),
        locked_s AS (
          SELECT s.inbox_id, s.messages, s.bytes, mb.quota_messages, mb.quota_bytes, mb.expires_at
          FROM inbox_state s
          JOIN mailboxes mb ON mb.id = s.inbox_id
          WHERE s.workspace_id = wid AND s.inbox_id IN (SELECT mailbox_id FROM need)
          ORDER BY s.inbox_id
          FOR UPDATE OF s
        )
        SELECT 1 FROM need n LEFT JOIN locked_s s ON s.inbox_id = n.mailbox_id
        WHERE s.inbox_id IS NULL
           OR s.expires_at <= statement_timestamp()
           OR s.messages + n.add_msgs > s.quota_messages
           OR s.bytes + n.add_bytes > s.quota_bytes
      ) THEN
        fast_ok := true;
      END IF;
    END IF;
  END IF;

  IF fast_ok THEN
    -- Ensure inbox folders exist for every target inbox (rolling-deploy guard from inbox_file_delivery).
    FOR bid IN SELECT DISTINCT mailbox_id FROM _batch_ing ORDER BY mailbox_id LOOP
      IF NOT EXISTS (SELECT 1 FROM inbox_folders WHERE inbox_id = bid AND role = 'inbox') THEN
        PERFORM inbox_seed_folders(bid);
      END IF;
    END LOOP;

    -- 1. Resolve thread_id for all items in one set-based query (preserving In-Reply-To / References & SES provider lookup).
    UPDATE _batch_ing b SET thread_id = coalesce((
      SELECT coalesce(i.thread_id, provider.thread_id)
      FROM jsonb_array_elements_text(b.refs) WITH ORDINALITY refs(ref, n)
      LEFT JOIN mail_message_ids i ON i.workspace_id = wid AND i.message_id = ref
      LEFT JOIN LATERAL (
        SELECT p.thread_id FROM sending_emails e
        JOIN mail_messages p ON p.sending_email_id = e.id AND p.workspace_id = e.workspace_id
        WHERE i.thread_id IS NULL
          AND ref ~ '^[A-Za-z0-9_-]+@(email|[a-z]{2}-[a-z0-9-]+-[0-9]+)[.]amazonses[.]com$'
          AND e.workspace_id = wid
          AND e.provider_id = split_part(ref, '@', 1)
          AND e.region = CASE split_part(split_part(ref, '@', 2), '.', 1) WHEN 'email' THEN 'us-east-1' ELSE split_part(split_part(ref, '@', 2), '.', 1) END
          AND ref = e.provider_id || '@' || CASE e.region WHEN 'us-east-1' THEN 'email' ELSE e.region END || '.amazonses.com'
        LIMIT 1
      ) provider ON true
      WHERE coalesce(i.thread_id, provider.thread_id) IS NOT NULL
      ORDER BY n LIMIT 1
    ), row_id('thr'));

    -- 2. Aggregate mail_threads upsert (1 row update per thread instead of N).
    INSERT INTO mail_threads AS t(id, workspace_id, message_count, last_message_at)
    SELECT b.thread_id, wid, count(*)::int, max(b.received_at)
    FROM _batch_ing b
    GROUP BY b.thread_id
    ORDER BY b.thread_id
    ON CONFLICT (id) DO UPDATE SET
      message_count = t.message_count + excluded.message_count,
      last_message_at = greatest(t.last_message_at, excluded.last_message_at);

    -- 3. Bulk insert mail_messages (fires statement-level billing_meter_mail once for all N rows).
    INSERT INTO mail_messages(
      "id","workspace_id","direction","region","ses_message_id","message_id","in_reply_to","references",
      "subject","from_address","from_name","to","cc","bcc","reply_to","envelope_from","envelope_to",
      "sent_at","received_at","text","html","body_truncated","snippet","headers","attachment_count",
      "size_bytes","raw_bucket","raw_key","verdicts","spam","automated","status",lifecycle,mime,thread_id
    )
    SELECT x."id",x."workspace_id",x."direction",x."region",x."ses_message_id",x."message_id",x."in_reply_to",x."references",
           x."subject",x."from_address",x."from_name",x."to",x."cc",x."bcc",x."reply_to",x."envelope_from",x."envelope_to",
           x."sent_at",x."received_at",x."text",x."html",x."body_truncated",x."snippet",x."headers",x."attachment_count",
           x."size_bytes",x."raw_bucket",x."raw_key",x."verdicts",x."spam",x."automated",x."status",b.lifecycle,x.mime,b.thread_id
    FROM _batch_ing b
    CROSS JOIN LATERAL jsonb_populate_record(NULL::mail_messages, b.msg) x
    ORDER BY b.ord;

    -- 4. Bulk insert mail_message_ids and mailgw_previews.
    INSERT INTO mail_message_ids(workspace_id, message_id, mail_message_id, thread_id)
    SELECT wid, b.msg_id, b.mid, b.thread_id FROM _batch_ing b WHERE b.msg_id IS NOT NULL
    ON CONFLICT DO NOTHING;

    INSERT INTO mailgw_previews
    SELECT b.mid, b.msg->>'raw_key', b.prefix, b.complete
    FROM _batch_ing b
    WHERE b.prefix IS NOT NULL AND b.lifecycle = 'kept'
    ON CONFLICT (mid) DO NOTHING;

    -- 5. Acquire events lane once, bulk insert events, queue 1 coalesced mailbox.fanout job if needed,
    --    and bulk insert mailbox_messages + inbox_entries + aggregate inbox_state/inbox_folders/mailbox_threads/mail_receipts.
    INSERT INTO mailbox_write_lanes(workspace_id, lane) VALUES(wid, 'events')
      ON CONFLICT(workspace_id, lane) DO UPDATE SET lane = excluded.lane;

    WITH ev_rows AS (
      SELECT b.ord, 1 AS kind_ord, wid AS workspace_id, 'message.stored'::text AS type, NULL::text AS mailbox_id, b.thread_id, b.mid AS message_id, '{}'::jsonb AS data
      FROM _batch_ing b
      UNION ALL
      SELECT b.ord, 3 AS kind_ord, wid AS workspace_id, 'message.received'::text AS type, b.mailbox_id, b.thread_id, b.mid AS message_id,
             jsonb_build_object('spam', false, 'automated', coalesce((b.msg->>'automated')::boolean, false), 'dmarc', b.dmarc) AS data
      FROM _batch_ing b
    ),
    events AS (
      INSERT INTO mailbox_events(workspace_id, type, mailbox_id, thread_id, message_id, data)
      SELECT workspace_id, type, mailbox_id, thread_id, message_id, data
      FROM ev_rows ORDER BY ord, kind_ord
      RETURNING seq, workspace_id, type, mailbox_id, message_id
    ),
    subscribed AS (
      SELECT e.workspace_id, e.seq, h.id
      FROM events e
      CROSS JOIN LATERAL (
        SELECT id, event_types, mailbox_ids, junk, format, include
        FROM mailbox_webhooks WHERE workspace_id = wid AND event_types <> '[]' ORDER BY paused, id LIMIT 64
      ) h
      WHERE (e.mailbox_id IS NOT NULL OR e.type <> 'message.received')
        AND (h.event_types ? e.type)
        AND (h.mailbox_ids IS NULL OR (e.type <> 'message.stored' AND h.mailbox_ids ? e.mailbox_id))
    ),
    subscriptions AS (
      SELECT s.workspace_id, s.seq,
             jsonb_agg(CASE WHEN g.ids IS NOT NULL THEN jsonb_build_object('id', s.id, 'subscription', true, 'grants', g.ids) ELSE to_jsonb(s.id) END) AS hooks
      FROM subscribed s
      LEFT JOIN LATERAL (
        SELECT jsonb_agg(DISTINCT grant_id) AS ids FROM mail_grant_objects
        WHERE workspace_id = wid AND kind = 'endpoint' AND resource = s.id
      ) g ON true
      GROUP BY s.workspace_id, s.seq
    ),
    queued AS (
      INSERT INTO jobs(id, type, workspace_id, payload)
      SELECT row_id('job'), 'mailbox.fanout', workspace_id, jsonb_object_agg(seq::text, hooks)
      FROM subscriptions GROUP BY workspace_id
      RETURNING 1
    ),
    numbered AS (
      SELECT b.ord,
             s.modseq + row_number() OVER (PARTITION BY b.mailbox_id ORDER BY b.ord) AS new_modseq,
             f.uid_next + row_number() OVER (PARTITION BY b.mailbox_id ORDER BY b.ord) - 1 AS new_uid,
             e.seq AS delivery_seq
      FROM _batch_ing b
      JOIN inbox_state s ON s.inbox_id = b.mailbox_id
      JOIN inbox_folders f ON f.inbox_id = b.mailbox_id AND f.role = 'inbox'
      JOIN events e ON e.type = 'message.received' AND e.mailbox_id = b.mailbox_id AND e.message_id = b.mid
    ),
    stamped AS (
      UPDATE _batch_ing b
      SET delivery_seq = n.delivery_seq, new_modseq = n.new_modseq, new_uid = n.new_uid
      FROM numbered n WHERE b.ord = n.ord
    )
    SELECT (SELECT count(*)::int FROM queued) INTO q_count;

    -- 6. Insert mailbox_messages first (separate statement so inbox_entries FK sees the new rows).
    INSERT INTO mailbox_messages(mailbox_id, message_id, workspace_id, thread_id, direction, read, received_at, labels, held_reason, reply_author_verified, modseq, flags, inbox_seq)
    SELECT b.mailbox_id, b.mid, wid, b.thread_id, 'inbound', false, b.received_at, ARRAY[]::text[], NULL,
           coalesce((b.msg->>'reply_author_verified')::boolean, false), b.new_modseq, 0, b.delivery_seq
    FROM _batch_ing b ORDER BY b.mailbox_id, b.ord;

    -- 7. Bulk insert inbox_entries and aggregate inbox_state, inbox_folders, mailbox_threads, and mail_receipts.
    INSERT INTO inbox_entries(inbox_id, role, uid, message_id, modseq, internal_date)
    SELECT b.mailbox_id, 'inbox', b.new_uid, b.mid, b.new_modseq, b.received_at
    FROM _batch_ing b ORDER BY b.mailbox_id, b.ord;

    WITH agg_box AS (
      SELECT mailbox_id, count(*)::int AS cnt, sum(size_bytes)::bigint AS bytes, max(new_modseq) AS max_modseq
      FROM _batch_ing GROUP BY mailbox_id
    ),
    upd_state AS (
      UPDATE inbox_state s
      SET messages = s.messages + a.cnt,
          bytes = s.bytes + a.bytes,
          unread = s.unread + a.cnt,
          modseq = a.max_modseq
      FROM agg_box a WHERE s.inbox_id = a.mailbox_id
    ),
    upd_folders AS (
      UPDATE inbox_folders f
      SET uid_next = f.uid_next + a.cnt,
          total = f.total + a.cnt,
          unseen = f.unseen + a.cnt,
          highest_modseq = a.max_modseq
      FROM agg_box a WHERE f.inbox_id = a.mailbox_id AND f.role = 'inbox'
    ),
    upd_threads AS (
      INSERT INTO mailbox_threads AS t(mailbox_id, thread_id, workspace_id, message_count, unread_count, last_message_at, last_inbound_at, spam, labels)
      SELECT b.mailbox_id, b.thread_id, wid, count(*)::int, count(*)::int, max(b.received_at), max(b.received_at), false, ARRAY[]::text[]
      FROM _batch_ing b
      GROUP BY b.mailbox_id, b.thread_id
      ORDER BY b.mailbox_id, b.thread_id
      ON CONFLICT (mailbox_id, thread_id) DO UPDATE SET
        message_count = t.message_count + excluded.message_count,
        unread_count = t.unread_count + excluded.unread_count,
        last_message_at = greatest(t.last_message_at, excluded.last_message_at),
        last_inbound_at = greatest(t.last_inbound_at, excluded.last_inbound_at),
        archived = false
    )
    UPDATE mail_receipts r
    SET status = 'processed',
        processed_at = now(),
        routing = CASE WHEN b.plan IS NOT NULL THEN mail_routing_trace(b.plan) END,
        dropped_recipients = 0,
        error = NULL
    FROM _batch_ing b
    WHERE r.workspace_id = wid AND r.ses_message_id = b.ses_id;

    w_ms := extract(epoch FROM locked - started) * 1000;
    h_ms := extract(epoch FROM clock_timestamp() - locked) * 1000;
    FOR rec IN SELECT b.ord, b.ses_id FROM _batch_ing b ORDER BY b.ord LOOP
      ses_message_id := rec.ses_id;
      queued_count := CASE WHEN rec.ord = 1 THEN q_count ELSE 0 END;
      wait_ms := w_ms;
      hold_ms := h_ms;
      RETURN NEXT;
    END LOOP;
    RETURN;
  END IF;

  -- Fallback path: execute each item sequentially through the exact single-message store function
  -- inside the same transaction (still saving N-1 round trips, lock waits, and WAL commits).
  FOR rec IN
    SELECT e->'msg' AS msg,
           coalesce(e->'files', '[]'::jsonb) AS files,
           coalesce(e->'refs', '[]'::jsonb) AS refs,
           coalesce(e->'envelopes', '[]'::jsonb) AS envelopes,
           coalesce((e->>'authenticated_from')::boolean, false) AS auth_from,
           coalesce((e->>'can_create')::boolean, false) AS can_create,
           CASE WHEN e->'plan' IS NOT NULL AND jsonb_typeof(e->'plan') <> 'null' THEN e->'plan' END AS plan,
           e->>'prefix' AS prefix,
           coalesce((e->>'complete')::boolean, false) AS complete
    FROM jsonb_array_elements(items) WITH ORDINALITY t(e, ord)
    ORDER BY ord
  LOOP
    SELECT * INTO res FROM mail_store_incoming(
      rec.msg, rec.files, rec.refs, rec.envelopes,
      rec.auth_from, rec.can_create, rec.plan, policy, rec.prefix, rec.complete
    );
    ses_message_id := rec.msg->>'ses_message_id';
    queued_count := coalesce(res.queued_count, 0);
    wait_ms := coalesce(res.wait_ms, 0);
    hold_ms := coalesce(res.hold_ms, 0);
    RETURN NEXT;
  END LOOP;
END $$;
