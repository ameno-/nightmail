SET LOCAL lock_timeout='2s';
-- Monitor-owned: no trigger, FK, lock, index or receipt write on a request table.
-- The timestamp and count are from the exact MVCC snapshot that produced the signals.
-- The sign-in source uses "C": its derived text keys must match the index
-- collation for PostgreSQL to probe the full receipt key, not just its stage.
CREATE TABLE abuse_work_versions (
  stage text NOT NULL, source_key text COLLATE "C" NOT NULL, version_at timestamptz NOT NULL, version_count integer NOT NULL DEFAULT 0,
  failures integer NOT NULL DEFAULT 0, reason text,
  PRIMARY KEY (stage,source_key,version_at,version_count)
);
CREATE INDEX abuse_work_retention ON abuse_work_versions(version_at);
CREATE FUNCTION abuse_key(VARIADIC parts text[]) RETURNS text LANGUAGE sql STABLE PARALLEL SAFE AS $$
  SELECT encode(sha256(convert_to(array_to_json(parts)::text,'UTF8')),'hex')
$$;
-- Stage physical hints, never raw subjects or signals. The fold validates the
-- digest, then re-reads by subject under its privacy guards. VACUUM FULL, a
-- concurrent update or tuple reuse can invalidate a hint, never receipt a row.
CREATE TABLE abuse_signin_queue (
  source_key text COLLATE "C" PRIMARY KEY, source_tid tid NOT NULL, version_at timestamptz NOT NULL, order_key text COLLATE "C" NOT NULL
);
CREATE INDEX abuse_signin_queue_head ON abuse_signin_queue(version_at,order_key,source_key);
ALTER TABLE abuse_state ADD COLUMN signin_scan_block bigint NOT NULL DEFAULT 0,
  ADD COLUMN signin_scan_end bigint, ADD COLUMN signin_rescan boolean NOT NULL DEFAULT false, ADD COLUMN signin_seek jsonb;

-- One pass over a fixed physical extent, including old pages on every new pass:
-- late commits, moved rows and replacements behind the seek cannot be lost to
-- a watermark. Persist the extent, next page and hints in the same transaction.
CREATE FUNCTION abuse_stage_signin_page() RETURNS bigint LANGUAGE plpgsql AS $$
DECLARE state abuse_state%ROWTYPE; stop_block bigint; next_block bigint;
BEGIN
  SELECT * INTO STRICT state FROM abuse_state WHERE id='monitor';
  IF state.signin_scan_block < 0 THEN RETURN -1; END IF;
  stop_block := coalesce(state.signin_scan_end,pg_relation_size('nightmail_signin_attempts') / current_setting('block_size')::int);
  next_block := least(stop_block,state.signin_scan_block+64);
  -- The privacy command holds the exclusive graph lock while removing hints
  -- and clearing observations. A scanner after it takes a fresh MVCC snapshot.
  PERFORM pg_advisory_xact_lock_shared(327461638,1);
  WITH page AS MATERIALIZED (
    SELECT a.ctid AS source_tid,a.last_at,a.attempts,abuse_key(a.issuer,a.subject) AS source_key,md5(a.issuer||' '||a.subject) AS order_key
    FROM nightmail_signin_attempts a
    WHERE a.ctid >= format('(%s,0)',state.signin_scan_block)::tid AND a.ctid < format('(%s,0)',next_block)::tid
      AND a.observed IS NOT NULL AND a.last_at>state.active_since)
  INSERT INTO abuse_signin_queue AS q(source_key,source_tid,version_at,order_key)
    SELECT p.source_key,p.source_tid,p.last_at,p.order_key FROM page p
    WHERE (p.last_at,p.order_key)>(coalesce((state.cursors#>>'{signIns,at}')::timestamptz,state.active_since),coalesce(state.cursors#>>'{signIns,key}',''))
      AND coalesce((SELECT v.failures BETWEEN 1 AND 2 FROM abuse_work_versions v WHERE v.stage='signIns'
        AND (v.source_key,v.version_at,v.version_count)=(p.source_key,p.last_at,p.attempts)),true)
    ON CONFLICT(source_key) DO UPDATE SET source_tid=excluded.source_tid,version_at=excluded.version_at,order_key=excluded.order_key;
  IF next_block=stop_block THEN next_block := -1; END IF;
  UPDATE abuse_state SET signin_scan_block=next_block,signin_scan_end=stop_block,signin_seek=NULL WHERE id='monitor';
  RETURN next_block;
END $$;

-- last_at dates the evidence. pending_since dates the work, including an old link made pending again.
ALTER TABLE abuse_clusters ADD COLUMN score_requested_at timestamptz;
ALTER TABLE identity_links ADD COLUMN pending_since timestamptz;
UPDATE identity_links SET pending_since=last_at WHERE pending;
ALTER TABLE identity_links ALTER COLUMN pending_since SET DEFAULT now();
CREATE FUNCTION abuse_link_pending() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.pending AND NOT OLD.pending THEN NEW.pending_since := statement_timestamp(); END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER abuse_link_pending BEFORE UPDATE OF pending ON identity_links FOR EACH ROW EXECUTE FUNCTION abuse_link_pending();

CREATE FUNCTION abuse_rare_value(k text,v text) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT count(*)<=25 FROM (SELECT FROM abuse_signals WHERE kind=k AND value=v LIMIT 26) holders
$$;

-- Link one holder at a time: even inside a batch the rarity / partner limits see exactly
-- the preceding sign-ins, in observation order. Called by both the batch and workspace writers.
CREATE FUNCTION abuse_link_holder(holder_type text, holder_id text, touched_values jsonb) RETURNS void LANGUAGE sql AS $$
  WITH touched AS MATERIALIZED (
    SELECT mine.kind,mine.value FROM abuse_signals mine WHERE (mine.entity_type,mine.entity_id)=(holder_type,holder_id)
      AND mine.kind IN ('email','email_alias','email_domain','provider','net','card','send_domain','content','link')
      AND (touched_values IS NULL OR EXISTS (SELECT FROM jsonb_to_recordset(touched_values) t(kind text,value text) WHERE (t.kind,t.value)=(mine.kind,mine.value)))
      AND abuse_rare_value(mine.kind,mine.value)),
  -- Each touched value already passed the 25-holder rarity check in this snapshot.
  -- Probe that value index before sorting partners; walking the entity-ordered
  -- primary key for ORDER BY ... LIMIT otherwise scans unrelated holders.
  partners AS MATERIALIZED (SELECT DISTINCT o.entity_type,o.entity_id,o.kind FROM touched t
    CROSS JOIN LATERAL (SELECT entity_type,entity_id,kind FROM abuse_signals
      WHERE (kind,value)=(t.kind,t.value) LIMIT 25) o
    WHERE (o.entity_type,o.entity_id)<>(holder_type,holder_id) ORDER BY 1,2,3 LIMIT 100),
  pairs AS (SELECT p.entity_type,p.entity_id,p.kind,count(*)::int AS shared,min(greatest(m.first_at,o.first_at)) AS first_at,max(least(m.last_at,o.last_at)) AS last_at
    FROM partners p JOIN abuse_signals m ON (m.entity_type,m.entity_id,m.kind)=(holder_type,holder_id,p.kind)
    JOIN abuse_signals o ON (o.entity_type,o.entity_id,o.kind,o.value)=(p.entity_type,p.entity_id,m.kind,m.value)
    WHERE abuse_rare_value(m.kind,m.value) GROUP BY 1,2,3)
  INSERT INTO identity_links(a_type,a_id,b_type,b_id,kind,shared,first_at,last_at)
    SELECT CASE WHEN first THEN holder_type ELSE entity_type END,CASE WHEN first THEN holder_id ELSE entity_id END,
      CASE WHEN first THEN entity_type ELSE holder_type END,CASE WHEN first THEN entity_id ELSE holder_id END,kind,shared,first_at,last_at
    FROM (SELECT p.*,(holder_type,holder_id)<(entity_type,entity_id) AS first FROM pairs p) ordered
    ON CONFLICT (a_type,a_id,b_type,b_id,kind) DO UPDATE SET shared=excluded.shared,first_at=least(identity_links.first_at,excluded.first_at),
      last_at=greatest(identity_links.last_at,excluded.last_at),pending=identity_links.pending OR identity_links.shared<>excluded.shared
$$;

-- Inputs have been re-read under the subject/user locks and validated
-- against the closed signal schema. The receipt and all derived writes commit together.
CREATE FUNCTION abuse_fold_signins(batch jsonb, next_seek jsonb) RETURNS integer LANGUAGE plpgsql AS $$
DECLARE r record; holder_type text; holder_id text; g_subject text; floor_at timestamptz; blocked boolean; added integer := 0; n integer;
BEGIN
  FOR r IN SELECT * FROM jsonb_to_recordset(batch) AS x(issuer text,subject text,user_id text,attempt text,at timestamptz,signals jsonb) LOOP
    holder_type := CASE WHEN r.user_id IS NULL THEN 'attempt' ELSE 'user' END;
    holder_id := coalesce(r.user_id,r.attempt);
    g_subject := r.issuer||' '||r.subject;
    SELECT EXISTS (SELECT FROM abuse_exclusions e WHERE (e.entity_type,e.entity_id) IN (('subject',g_subject),('user',r.user_id))),
      coalesce((SELECT max(f.ignore_through) FROM abuse_floors f WHERE (f.entity_type,f.entity_id) IN (('subject',g_subject),('user',r.user_id))),'-infinity')
      INTO blocked,floor_at;
    IF r.signals IS NOT NULL AND NOT blocked THEN
      IF r.at>floor_at THEN
        WITH wrote AS (INSERT INTO abuse_signals(entity_type,entity_id,kind,value,detail,first_at,last_at)
          SELECT DISTINCT ON (s.kind,s.value) holder_type,holder_id,s.kind,s.value,s.detail,r.at,r.at FROM jsonb_to_recordset(r.signals) s(kind text,value text,detail jsonb)
          ON CONFLICT (entity_type,entity_id,kind,value) DO UPDATE SET seen=abuse_signals.seen+1,last_at=greatest(abuse_signals.last_at,excluded.last_at),detail=coalesce(excluded.detail,abuse_signals.detail)
          RETURNING xmax=0 AS fresh)
        SELECT count(*) FILTER (WHERE fresh) INTO n FROM wrote;
        added := added+n;
      END IF;
      IF r.user_id IS NOT NULL THEN
        WITH moved AS (DELETE FROM abuse_signals WHERE entity_type='attempt' AND entity_id=r.attempt RETURNING *)
        INSERT INTO abuse_signals(entity_type,entity_id,kind,value,seen,detail,first_at,last_at)
          SELECT holder_type,holder_id,kind,value,seen,detail,first_at,last_at FROM moved WHERE last_at>floor_at
          ON CONFLICT (entity_type,entity_id,kind,value) DO UPDATE SET seen=abuse_signals.seen+excluded.seen,
            first_at=least(abuse_signals.first_at,excluded.first_at),last_at=greatest(abuse_signals.last_at,excluded.last_at);
      END IF;
      DELETE FROM abuse_signals s USING (SELECT kind,value,row_number() OVER (PARTITION BY kind ORDER BY last_at DESC,value) AS n
        FROM abuse_signals WHERE entity_type=holder_type AND entity_id=holder_id) old
        WHERE s.entity_type=holder_type AND s.entity_id=holder_id AND s.kind=old.kind AND s.value=old.value AND old.n>100;
      PERFORM abuse_link_holder(holder_type,holder_id,CASE WHEN r.user_id IS NULL THEN r.signals END);
    END IF;
  END LOOP;
  INSERT INTO abuse_work_versions(stage,source_key,version_at,version_count)
    SELECT 'signIns',source_key,at,attempts FROM jsonb_to_recordset(batch) x(source_key text,at timestamptz,attempts int)
    ON CONFLICT (stage,source_key,version_at,version_count) DO UPDATE SET failures=0,reason=NULL;
  DELETE FROM abuse_signin_queue WHERE source_key=ANY(ARRAY(SELECT x.source_key FROM jsonb_to_recordset(batch) x(source_key text)));
  -- Carry the clean prefix over a job or process boundary. Without this seek,
  -- even a LIMIT on the head index can revisit dead entries before VACUUM.
  IF next_seek IS NOT NULL THEN UPDATE abuse_state SET signin_seek=next_seek WHERE id='monitor' AND signin_scan_block<0; END IF;
  RETURN added;
END $$;

-- Separate indexed heads keep low-priority jobs out of the head page for ordinary work.
-- None of these types existed before this migration, so existing expression index keys do not change.
CREATE OR REPLACE FUNCTION job_class(t text) RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$ SELECT CASE
  WHEN t IN ('operation.webhook','mailbox.webhook','mailbox.fanout') THEN 'hook' WHEN starts_with(t,'campaign.') THEN 'campaign'
  WHEN t='mailbox.ingest' THEN 'ingest' WHEN t IN ('operation.ses','operation.simulatedFeedback','operation.simulatedFeedbackRecovery') THEN 'feedback'
  WHEN t IN ('operation.publish','operation.publishBatch') THEN 'publish'
  WHEN t='abuse.stage.sample' THEN 'abuse_sample' WHEN starts_with(t,'abuse.stage.') THEN 'abuse' ELSE 'other' END $$;
