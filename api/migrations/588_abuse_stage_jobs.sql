SET LOCAL lock_timeout='2s';
-- The observation stays with the source row. A changed version becomes eligible without
-- moving a global cursor, including an update that commits behind a batch already folded.
ALTER TABLE nightmail_signin_attempts ADD COLUMN abuse_folded_at timestamptz, ADD COLUMN abuse_folded_attempts integer;
ALTER TABLE billing_payment_attempts ADD COLUMN abuse_folded_at timestamptz;
-- last_at dates the evidence. pending_since dates the work, including an old link made pending again.
ALTER TABLE abuse_clusters ADD COLUMN score_requested_at timestamptz;
ALTER TABLE identity_links ADD COLUMN pending_since timestamptz NOT NULL DEFAULT now();
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
  WITH touched AS (
    SELECT mine.kind,mine.value FROM abuse_signals mine WHERE (mine.entity_type,mine.entity_id)=(holder_type,holder_id)
      AND mine.kind IN ('email','email_alias','email_domain','provider','net','card','send_domain','content','link')
      AND (touched_values IS NULL OR EXISTS (SELECT FROM jsonb_to_recordset(touched_values) t(kind text,value text) WHERE (t.kind,t.value)=(mine.kind,mine.value)))
      AND abuse_rare_value(mine.kind,mine.value)),
  partners AS (SELECT DISTINCT o.entity_type,o.entity_id,o.kind FROM touched t JOIN abuse_signals o USING(kind,value)
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

-- Inputs have been re-read under the subject/user locks and source-row lock and validated
-- against the closed signal schema. The receipt and all derived writes commit together.
CREATE FUNCTION abuse_fold_signins(batch jsonb) RETURNS integer LANGUAGE plpgsql AS $$
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
  UPDATE nightmail_signin_attempts a SET abuse_folded_at=a.last_at,abuse_folded_attempts=a.attempts
    FROM jsonb_to_recordset(batch) x(issuer text,subject text) WHERE (a.issuer,a.subject)=(x.issuer,x.subject);
  RETURN added;
END $$;

-- Separate indexed heads keep low-priority jobs out of the head page for ordinary work.
-- None of these types existed before this migration, so existing expression index keys do not change.
CREATE OR REPLACE FUNCTION job_class(t text) RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$ SELECT CASE
  WHEN t IN ('operation.webhook','mailbox.webhook','mailbox.fanout') THEN 'hook' WHEN starts_with(t,'campaign.') THEN 'campaign'
  WHEN t='mailbox.ingest' THEN 'ingest' WHEN t IN ('operation.ses','operation.simulatedFeedback','operation.simulatedFeedbackRecovery') THEN 'feedback'
  WHEN t IN ('operation.publish','operation.publishBatch') THEN 'publish'
  WHEN t='abuse.stage.sample' THEN 'abuse_sample' WHEN starts_with(t,'abuse.stage.') THEN 'abuse' ELSE 'other' END $$;
