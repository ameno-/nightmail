SET LOCAL lock_timeout='2s';

-- Receiving headroom (docs/receiving-operations.md).
--
-- The inbound budget per workspace is 50,000 messages and 20 GiB an hour (was 5,000 and 2 GiB) with 20,000 active
-- ingest jobs (was 5,000). Limit rows that still hold the old defaults move with them (a spam-policy change stores the
-- defaults in a row); any other operator value stays.
--
-- The budget refills continuously instead of resetting at the top of each hour: a bucket of one hour's budget, refilled
-- at the hourly rate (level_at, message_level and byte_level on the window row; the clock-hour counters stay, for
-- reading only). A burst up to the budget is admitted at once and any 60 minutes still admit at most twice the budget,
-- as the clock-hour window did. Mail over the budget no longer waits for the next hour: it takes the next slot, charged
-- at once, while that slot is at most a quarter of an hour of refill ahead (MAILBOX_RECEIVE_QUEUED, due when its slot
-- comes up). Only mail past that, a flood, is held for the next hour as before (MAILBOX_RECEIVE_BUDGET) and then takes
-- a slot or a place in line. The ingest job's byte budget works the same way (mailbox-ingest.ts). The minute cron starts
-- the release when a hold is due (scheduleHoldRelease), so a queued message waits about as long as its slot.
ALTER TABLE mail_receive_limits ALTER message_limit SET DEFAULT 50000, ALTER byte_limit SET DEFAULT 21474836480, ALTER backlog_limit SET DEFAULT 20000;
UPDATE mail_receive_limits SET message_limit=50000 WHERE message_limit=5000;
UPDATE mail_receive_limits SET byte_limit=21474836480 WHERE byte_limit=2147483648;
UPDATE mail_receive_limits SET backlog_limit=20000 WHERE backlog_limit=5000;
CREATE OR REPLACE FUNCTION mail_receive_policy(wid text) RETURNS TABLE(messages int,bytes bigint,backlog int) LANGUAGE sql STABLE AS $$
 SELECT coalesce(l.message_limit,50000),coalesce(l.byte_limit,21474836480),coalesce(l.backlog_limit,20000)
 FROM (SELECT wid AS workspace_id) w LEFT JOIN mail_receive_limits l USING(workspace_id)
$$;

ALTER TABLE mail_receive_windows ADD COLUMN level_at timestamptz,
  ADD COLUMN message_level double precision NOT NULL DEFAULT 0, ADD COLUMN byte_level double precision NOT NULL DEFAULT 0;

-- A budget's level now: what it held at level_at, drained at the hourly limit since.
CREATE FUNCTION mail_receive_level(level double precision,at timestamptz,per_hour double precision) RETURNS double precision LANGUAGE sql STABLE AS $$
 SELECT greatest(0,level-greatest(0,extract(epoch FROM now()-coalesce(at,now()))::double precision)*per_hour/3600)
$$;

-- One message of a workspace's budget, under its window row (every route statement takes that row first, 157):
-- admitted when the bucket has room. Otherwise, with queue, the next slot is charged at once and due says when it comes
-- up, while that is at most a quarter of an hour of refill ahead; past that (or without queue) nothing is charged and
-- due is NULL.
CREATE FUNCTION mail_receive_take(wid text,queue boolean,OUT admitted boolean,OUT due timestamptz) LANGUAGE plpgsql AS $$
DECLARE h timestamptz:=date_trunc('hour',now()); p record; w mail_receive_windows; level double precision;
BEGIN
 admitted:=false;
 INSERT INTO mail_receive_windows AS x VALUES(wid,h,0,0) ON CONFLICT(workspace_id) DO UPDATE SET messages=x.messages WHERE false;
 SELECT * INTO p FROM mail_receive_policy(wid);
 IF p.messages<=0 THEN RETURN; END IF;
 SELECT * INTO w FROM mail_receive_windows WHERE workspace_id=wid;
 level:=mail_receive_level(w.message_level,w.level_at,p.messages)+1;
 admitted:=level<=p.messages;
 IF NOT admitted AND (NOT queue OR level>p.messages*1.25) THEN RETURN; END IF;
 IF NOT admitted THEN due:=now()+make_interval(secs=>(level-p.messages)*3600/p.messages); END IF;
 UPDATE mail_receive_windows SET message_level=level,byte_level=mail_receive_level(byte_level,level_at,p.bytes),level_at=greatest(level_at,now()),
   messages=CASE WHEN window_at<>h THEN admitted::int WHEN admitted THEN messages+1 ELSE messages END,bytes=CASE WHEN window_at=h THEN bytes ELSE 0 END,window_at=h
  WHERE workspace_id=wid;
END $$;
CREATE OR REPLACE FUNCTION mail_receive_slot(wid text) RETURNS boolean LANGUAGE sql AS $$ SELECT admitted FROM mail_receive_take(wid,false) $$;

-- 157's receipt trigger, taking a slot or a place in line from the bucket.
CREATE OR REPLACE FUNCTION mail_receive_admit() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE slot record;
BEGIN
 IF NEW.status<>'pending' THEN RETURN NEW; END IF;
 -- The window row first (the no-op upsert locks it even when its UPDATE predicate is false), then
 -- the receipt. A first receipt is rechecked after the wait (153).
 INSERT INTO mail_receive_windows AS w VALUES(NEW.workspace_id,date_trunc('hour',now()),0,0) ON CONFLICT(workspace_id) DO UPDATE SET messages=w.messages WHERE false;
 IF EXISTS(SELECT FROM mail_receipts WHERE workspace_id=NEW.workspace_id AND ses_message_id=NEW.ses_message_id) THEN
   NEW.recipients:=mail_receive_new_recipients(NEW.workspace_id,NEW.ses_message_id,NEW.recipients);RETURN NEW;
 END IF;
 IF jsonb_array_length(NEW.recipients)>100 THEN
   NEW.status:='failed';NEW.processed_at:=now();NEW.error:='MAILBOX_RECEIVE_BUDGET';
   RETURN NEW;
 END IF;
 SELECT * INTO slot FROM mail_receive_take(NEW.workspace_id,true);
 IF NOT slot.admitted THEN
   NEW.status:='held';NEW.error:=CASE WHEN slot.due IS NULL THEN 'MAILBOX_RECEIVE_BUDGET' ELSE 'MAILBOX_RECEIVE_QUEUED' END;
   NEW.budget_retry_at:=coalesce(slot.due,date_trunc('hour',now())+interval '1 hour');
 END IF;
 RETURN NEW;
END $$;

-- 156's release, also for budget holds alone (budget_only: the minute release, which leaves backlog holds to the
-- job-end drain and the hourly pass, as before). A queued hold was charged when it was queued: it only counts in this
-- hour's window. Any other budget hold takes a slot or a place in line, or waits for the next hour.
CREATE FUNCTION release_receive_holds(owner_filter text,budget_only boolean) RETURNS int LANGUAGE plpgsql AS $$
DECLARE r record; scanned int:=0; free boolean; coalesced boolean; slot record; h timestamptz:=date_trunc('hour',now());
BEGIN
 FOR r IN SELECT workspace_id AS wid,ses_message_id AS mid,created_at,error FROM mail_receipts WHERE status='held' AND budget_retry_at<=now()
   AND (owner_filter IS NULL OR workspace_id=owner_filter) AND (NOT budget_only OR error<>'MAILBOX_RECEIVE_BACKLOG')
   ORDER BY budget_retry_at,workspace_id,ses_message_id LIMIT 100 FOR UPDATE SKIP LOCKED LOOP
   scanned:=scanned+1;
   IF r.created_at<now()-interval '3 days' THEN
     UPDATE mail_receipts SET status='failed',error='MAILBOX_BUDGET_HOLD_EXPIRED',processed_at=now(),budget_retry_at=NULL WHERE workspace_id=r.wid AND ses_message_id=r.mid;
     CONTINUE;
   END IF;
   PERFORM FROM mail_receive_windows WHERE workspace_id=r.wid FOR UPDATE SKIP LOCKED;
   free:=FOUND;
   IF free AND EXISTS(SELECT FROM mail_ingest_turns WHERE workspace_id=r.wid) THEN
     PERFORM FROM mail_ingest_turns WHERE workspace_id=r.wid FOR UPDATE SKIP LOCKED;
     free:=FOUND;
   END IF;
   IF NOT free THEN
     UPDATE mail_receipts SET budget_retry_at=now()+interval '10 seconds' WHERE workspace_id=r.wid AND ses_message_id=r.mid;
     CONTINUE;
   END IF;
   IF r.error='MAILBOX_RECEIVE_BACKLOG' THEN
     IF EXISTS(SELECT FROM jobs WHERE workspace_id=r.wid AND type='mailbox.ingest' AND payload->>'sesMessageId'=r.mid AND status='running') THEN
       UPDATE mail_receipts SET budget_retry_at=now()+interval '10 seconds' WHERE workspace_id=r.wid AND ses_message_id=r.mid;
       CONTINUE;
     END IF;
     PERFORM FROM jobs WHERE workspace_id=r.wid AND type='mailbox.ingest' AND payload->>'sesMessageId'=r.mid AND status='pending' LIMIT 1 FOR UPDATE SKIP LOCKED;
     coalesced:=FOUND;
     IF NOT coalesced AND EXISTS(SELECT FROM jobs WHERE workspace_id=r.wid AND type='mailbox.ingest' AND payload->>'sesMessageId'=r.mid AND status='pending') THEN
       UPDATE mail_receipts SET budget_retry_at=now()+interval '10 seconds' WHERE workspace_id=r.wid AND ses_message_id=r.mid;
       CONTINUE;
     END IF;
     IF coalesced OR coalesce((SELECT active FROM mail_ingest_turns WHERE workspace_id=r.wid),0)<(SELECT p.backlog FROM mail_receive_policy(r.wid) p) THEN
       UPDATE mail_receipts SET status='pending',error=NULL,budget_retry_at=NULL WHERE workspace_id=r.wid AND ses_message_id=r.mid;
       INSERT INTO jobs(id,type,workspace_id,payload) VALUES('job_'||gen_random_uuid(),'mailbox.ingest',r.wid,jsonb_build_object('sesMessageId',r.mid));
     ELSE
       UPDATE mail_receipts SET budget_retry_at=date_trunc('hour',now())+interval '1 hour' WHERE workspace_id=r.wid AND ses_message_id=r.mid;
     END IF;
     CONTINUE;
   END IF;
   IF r.error='MAILBOX_RECEIVE_QUEUED' THEN
     UPDATE mail_receive_windows SET messages=CASE WHEN window_at=h THEN messages+1 ELSE 1 END,bytes=CASE WHEN window_at=h THEN bytes ELSE 0 END,window_at=h WHERE workspace_id=r.wid;
   ELSE
     SELECT * INTO slot FROM mail_receive_take(r.wid,true);
     IF NOT slot.admitted THEN
       UPDATE mail_receipts SET error=CASE WHEN slot.due IS NULL THEN error ELSE 'MAILBOX_RECEIVE_QUEUED' END,budget_retry_at=coalesce(slot.due,date_trunc('hour',now())+interval '1 hour')
        WHERE workspace_id=r.wid AND ses_message_id=r.mid;
       CONTINUE;
     END IF;
   END IF;
   UPDATE mail_receipts SET status='pending',error=NULL,budget_retry_at=NULL WHERE workspace_id=r.wid AND ses_message_id=r.mid;
   INSERT INTO jobs(id,type,workspace_id,payload) VALUES('job_'||gen_random_uuid(),'mailbox.ingest',r.wid,jsonb_build_object('sesMessageId',r.mid));
   -- Held again for the backlog: the drain or the next hour's pass admits it.
   UPDATE mail_receipts SET budget_retry_at=date_trunc('hour',now())+interval '1 hour' WHERE workspace_id=r.wid AND ses_message_id=r.mid AND status='held';
 END LOOP;
 RETURN scanned;
END $$;
CREATE OR REPLACE FUNCTION release_receive_budget_holds(owner_filter text) RETURNS int LANGUAGE sql AS $$ SELECT release_receive_holds(owner_filter,false) $$;

-- Catch-all address creation keeps its 50 new addresses per domain in a rolling hour (the dictionary-attack brake) and
-- drops the lifetime totals of 500 per domain and 2,000 per workspace for one of 50,000 per workspace, counted only when
-- an hourly slot is free. 163's mail_store_ritual_plan otherwise unchanged.
CREATE OR REPLACE FUNCTION mail_store_ritual_plan(msg jsonb, file_items jsonb, refs_json jsonb, envelopes jsonb, authenticated_from boolean, can_create boolean, plan jsonb)
RETURNS TABLE(queued_count integer,wait_ms double precision,hold_ms double precision) LANGUAGE plpgsql VOLATILE AS $$
DECLARE wid text:=msg->>'workspace_id'; received timestamptz:=(msg->>'received_at')::timestamptz; dmarc text:=msg#>>'{verdicts,dmarc}'; is_spam boolean:=(msg->>'spam')::boolean;
started timestamptz:=clock_timestamp(); locked timestamptz; published jsonb;
BEGIN
 INSERT INTO mailbox_write_lanes(workspace_id,lane) VALUES(wid,'ingest') ON CONFLICT(workspace_id,lane) DO UPDATE SET lane=excluded.lane WHERE false;
 IF EXISTS (SELECT FROM jsonb_to_recordset(envelopes) v(addr text) JOIN mailbox_addresses a ON a.workspace_id=wid AND a.address IN(v.addr,regexp_replace(v.addr,'[+][^@]*@','@')) JOIN mailboxes b ON b.id=a.mailbox_id WHERE b.delete_after<=statement_timestamp() AND NOT a.address LIKE '%.sandbox.invalid') THEN
  INSERT INTO mailbox_write_lanes(workspace_id,lane) VALUES(wid,'address') ON CONFLICT(workspace_id,lane) DO UPDATE SET lane=excluded.lane WHERE false;
  DELETE FROM mailbox_addresses a USING mailboxes b,jsonb_to_recordset(envelopes) v(addr text) WHERE a.mailbox_id=b.id AND a.workspace_id=wid AND b.delete_after<=statement_timestamp() AND NOT a.address LIKE '%.sandbox.invalid' AND a.address IN(v.addr,regexp_replace(v.addr,'[+][^@]*@','@'));
 END IF;
 -- A released implicit owner may now resolve via a rule, catch-all, or another owner.
 -- Reclaim rather than committing its old address-tier decision as an unrouted message.
 IF plan IS NOT NULL THEN
  IF EXISTS(SELECT FROM jsonb_array_elements(plan->'recipients') p CROSS JOIN jsonb_array_elements_text(p->'inboxes') dest(id)
     WHERE NOT coalesce((p->'added') ? dest.id,false) AND p->>'route' IS NULL AND p->>'tier' IN ('address','subaddress') AND NOT EXISTS(
       SELECT FROM mailbox_addresses a JOIN mailboxes b ON b.id=a.mailbox_id AND b.workspace_id=a.workspace_id
       WHERE a.workspace_id=wid AND a.mailbox_id=dest.id AND a.address IN(p->>'address',regexp_replace(p->>'address','[+][^@]*@','@')) AND (b.delete_after IS NULL OR b.delete_after>statement_timestamp()))) THEN
   RAISE EXCEPTION 'Address ownership changed; reclaim receipt' USING ERRCODE='40001';
  END IF;
  plan:=mail_apply_route(wid,plan,received,dmarc);
 END IF;
 can_create:=can_create AND NOT is_spam AND EXISTS(SELECT FROM jsonb_to_recordset(envelopes) AS v(addr text) JOIN mailbox_domains d ON d.workspace_id=wid AND coalesce(d.receiving_host,d.name)=split_part(addr,'@',2) AND d.catch_all='create_mailbox' WHERE (plan IS NULL OR EXISTS(SELECT FROM jsonb_array_elements(plan->'recipients') p WHERE p->>'address'=addr AND p->>'tier'='default')) AND NOT EXISTS(SELECT FROM mailbox_addresses a WHERE a.workspace_id=wid AND a.address IN (addr,regexp_replace(addr,'[+][^@]*@','@'))));
 IF can_create OR msg->>'lifecycle'='ephemeral' THEN INSERT INTO mailbox_write_lanes(workspace_id,lane) VALUES(wid,'address') ON CONFLICT(workspace_id,lane) DO UPDATE SET lane=excluded.lane WHERE false; END IF;
 IF plan IS NOT NULL AND jsonb_array_length(plan->'recipients')>0 AND NOT EXISTS(SELECT FROM jsonb_array_elements(plan->'recipients') r WHERE NOT (r->>'dropped')::boolean) THEN
  UPDATE mail_receipts SET status='processed',processed_at=now(),routing=mail_routing_trace(plan) WHERE workspace_id=wid AND ses_message_id=msg->>'ses_message_id' AND status='pending' AND recipients=msg->'envelope_to';
  queued_count:=0; wait_ms:=0; hold_ms:=0; RETURN NEXT; RETURN;
 END IF;
 PERFORM mail_inbox_precheck(wid,msg);
 locked:=clock_timestamp();
 WITH delivery AS MATERIALIZED (
    SELECT x.* FROM jsonb_populate_record(NULL::mail_messages,msg::jsonb) x
    JOIN mail_receipts r ON r.workspace_id=x.workspace_id AND r.ses_message_id=x.ses_message_id AND r.status='pending'
    WHERE r.recipients=x.envelope_to FOR UPDATE OF r
  ), extended AS (UPDATE mail_messages old SET envelope_to=(SELECT jsonb_agg(a ORDER BY n) FROM (SELECT a,min(n) AS n FROM jsonb_array_elements_text(old.envelope_to||x.envelope_to) WITH ORDINALITY e(a,n) GROUP BY a) u),lifecycle=CASE WHEN 'kept' IN (old.lifecycle,x.lifecycle) THEN 'kept' WHEN x.lifecycle='default' THEN 'default' ELSE old.lifecycle END,raw_bucket=CASE WHEN (old.lifecycle='ephemeral' OR x.lifecycle='kept') THEN x.raw_bucket ELSE old.raw_bucket END,raw_key=CASE WHEN (old.lifecycle='ephemeral' OR x.lifecycle='kept') THEN x.raw_key ELSE old.raw_key END FROM delivery x WHERE old.workspace_id=x.workspace_id AND old.id=x.id RETURNING old.*
  ), promoted_files AS (UPDATE mail_attachments a SET bucket=f->>'bucket',storage_key=f->>'storageKey' FROM extended x,jsonb_array_elements(file_items) f WHERE x.lifecycle IN ('default','kept') AND a.workspace_id=x.workspace_id AND a.message_id=x.id AND a.id=f->>'id' AND a.storage_key LIKE 'e/%'), input AS MATERIALIZED (SELECT x.* FROM delivery x WHERE NOT EXISTS(SELECT FROM extended)
  ), known AS MATERIALIZED (
    SELECT old.* FROM input x JOIN mail_message_ids i USING(workspace_id,message_id)
    JOIN mail_messages old ON old.id=i.mail_message_id AND old.workspace_id=x.workspace_id AND old.direction='inbound'
    WHERE x.status<>'unparsed' AND old.status<>'unparsed' AND (old.lifecycle=x.lifecycle OR old.lifecycle='default' AND x.lifecycle='ephemeral') AND old.from_address=x.from_address AND old.subject=x.subject AND old.text IS NOT DISTINCT FROM x.text AND old.html IS NOT DISTINCT FROM x.html
    AND old.attachment_count=x.attachment_count AND ARRAY(SELECT sha256 FROM mail_attachments WHERE message_id=old.id ORDER BY sha256)=ARRAY(SELECT f->>'sha256' FROM jsonb_array_elements(file_items) f ORDER BY 1)
  ), thread AS (
    INSERT INTO mail_threads AS t(id,workspace_id,message_count,last_message_at)
    SELECT coalesce(parent.thread_id,('thr_'||replace(gen_random_uuid()::text,'-',''))),x.workspace_id,1,x.received_at FROM input x
    LEFT JOIN LATERAL (SELECT coalesce(i.thread_id,provider.thread_id) AS thread_id FROM jsonb_array_elements_text(refs_json::jsonb) WITH ORDINALITY refs(ref,n)
      LEFT JOIN mail_message_ids i ON i.workspace_id=x.workspace_id AND i.message_id=ref
      LEFT JOIN LATERAL (SELECT p.thread_id FROM sending_emails e JOIN mail_messages p ON p.sending_email_id=e.id AND p.workspace_id=e.workspace_id
        WHERE i.thread_id IS NULL AND ref ~ '^[A-Za-z0-9_-]+@(email|[a-z]{2}-[a-z0-9-]+-[0-9]+)[.]amazonses[.]com$'
        AND e.workspace_id=x.workspace_id AND e.provider_id=split_part(ref,'@',1) AND e.region=CASE split_part(split_part(ref,'@',2),'.',1) WHEN 'email' THEN 'us-east-1' ELSE split_part(split_part(ref,'@',2),'.',1) END
        AND ref=e.provider_id||'@'||CASE e.region WHEN 'us-east-1' THEN 'email' ELSE e.region END||'.amazonses.com' LIMIT 1) provider ON true
      WHERE coalesce(i.thread_id,provider.thread_id) IS NOT NULL ORDER BY n LIMIT 1) parent ON true
    WHERE NOT EXISTS(SELECT 1 FROM known) ON CONFLICT(id) DO UPDATE SET message_count=t.message_count+1,last_message_at=greatest(t.last_message_at,excluded.last_message_at) RETURNING id
  ), stored AS (INSERT INTO mail_messages("id","workspace_id","direction","region","ses_message_id","message_id","in_reply_to","references","subject","from_address","from_name","to","cc","bcc","reply_to","envelope_from","envelope_to","sent_at","received_at","text","html","body_truncated","snippet","headers","attachment_count","size_bytes","raw_bucket","raw_key","verdicts","spam","automated","status",lifecycle,mime,thread_id) SELECT x."id",x."workspace_id",x."direction",x."region",x."ses_message_id",x."message_id",x."in_reply_to",x."references",x."subject",x."from_address",x."from_name",x."to",x."cc",x."bcc",x."reply_to",x."envelope_from",x."envelope_to",x."sent_at",x."received_at",x."text",x."html",x."body_truncated",x."snippet",x."headers",x."attachment_count",x."size_bytes",x."raw_bucket",x."raw_key",x."verdicts",x."spam",x."automated",x."status",coalesce(x.lifecycle,'default'),x.mime,thread.id FROM input x,thread RETURNING *
  ), stale AS MATERIALIZED (
    SELECT c.id,c.suppression_reason,s.id AS message_id FROM stored s JOIN audience_contacts c ON c.workspace_id=s.workspace_id AND c.email=s.from_address
    WHERE authenticated_from AND NOT s.spam AND c.suppressed AND c.suppression_reason IN ('hard_bounce','soft_bounce','transient','email_validation') AND c.marketing_consent<>'unsubscribed'
      AND s.sent_at IS NOT NULL AND s.sent_at<=s.received_at+interval '5 minutes'
      AND coalesce(c.suppressed_at,c.updated_at)<least(s.sent_at,s.received_at) FOR UPDATE OF c
  ), cleared AS (UPDATE audience_contacts c SET suppressed=false,suppression_reason=NULL,suppressed_at=NULL,updated_at=now() FROM stale
    WHERE c.id=stale.id RETURNING c.id AS contact_id,stale.suppression_reason,stale.message_id
  ), files AS (INSERT INTO mail_attachments(id,workspace_id,message_id,filename,content_type,size_bytes,content_id,disposition,sha256,bucket,storage_key)
    SELECT f.id,s.workspace_id,s.id,f.filename,f."contentType",f."sizeBytes",f."contentId",f.disposition,f.sha256,f.bucket,f."storageKey" FROM stored s CROSS JOIN jsonb_to_recordset(file_items::jsonb) f(id text,filename text,"contentType" text,"sizeBytes" int,"contentId" text,disposition text,sha256 text,bucket text,"storageKey" text)
  ), indexed AS (INSERT INTO mail_message_ids(workspace_id,message_id,mail_message_id,thread_id) SELECT workspace_id,message_id,id,thread_id FROM stored WHERE message_id IS NOT NULL ON CONFLICT DO NOTHING
  ), target AS MATERIALIZED (SELECT * FROM stored UNION ALL SELECT * FROM known UNION ALL SELECT * FROM extended),
  -- Recipients this email was already routed for, as of the statement's snapshot: the envelope a
  -- reopened receipt or an earlier receipt of the same email stored. Their webhook deliveries and
  -- ritual actions were queued then; a duplicate or reopened receipt routes only new recipients.
  routed_before AS MATERIALIZED (SELECT m.envelope_to FROM mail_messages m JOIN target x ON m.id=x.id AND m.workspace_id=x.workspace_id),
  -- Another SES receipt of a known email adds its recipients to the stored envelope, so a later
  -- duplicate or reopen of either receipt sees them as routed.
  known_envelope AS (UPDATE mail_messages m SET envelope_to=(SELECT jsonb_agg(a ORDER BY n) FROM (SELECT a,min(n) AS n FROM jsonb_array_elements_text(m.envelope_to||x.envelope_to) WITH ORDINALITY e(a,n) GROUP BY a) u)
    FROM known k CROSS JOIN input x WHERE m.id=k.id AND m.workspace_id=k.workspace_id AND NOT m.envelope_to @> x.envelope_to),
  routes AS MATERIALIZED (
    SELECT addr,base,n,d.id AS domain,d.catch_all,r.valid,o.owner,o.receives,pr.item,rule.id AS ruled,EXISTS(SELECT FROM mail_retired_addresses t WHERE t.workspace_id=wid AND t.address IN(addr,base) AND t.until>now() AND t.address LIKE '%.sandbox.invalid') AS retired
    FROM target x CROSS JOIN jsonb_to_recordset(envelopes::jsonb) r(addr text,n int,valid boolean)
    JOIN mailbox_domains d ON d.workspace_id=x.workspace_id AND coalesce(d.receiving_host,d.name)=split_part(addr,'@',2) AND (d.status='active' OR (d.receiving_host IS NULL AND d.status IN ('waiting_for_mx','provisioning')) OR (d.status='disabled' AND d.name LIKE '%.sandbox.invalid' AND msg#>>'{verdicts,simulated}'='true'))
    LEFT JOIN jsonb_array_elements(plan->'recipients') pr(item) ON pr.item->>'address'=addr
    CROSS JOIN LATERAL (SELECT regexp_replace(addr,'[+][^@]*@','@') AS base) plus
    LEFT JOIN LATERAL (SELECT b.id AS owner,a.kind<>'public' AND ((b.kind='inbox' AND b.delete_after>statement_timestamp()) OR b.expires_at IS NULL OR (b.created_at<=least(x.received_at,received::timestamptz) AND b.expires_at>greatest(statement_timestamp(),least(x.received_at,received::timestamptz)))) AS receives
      FROM mailbox_addresses a JOIN mailboxes b ON b.id=a.mailbox_id WHERE a.workspace_id=x.workspace_id AND (b.delete_after IS NULL OR b.delete_after>statement_timestamp()) AND (pr.item IS NULL OR pr.item->>'tier'='default') AND (a.address=addr OR a.address=base AND NOT coalesce((pr.item->>'skipBase')::boolean,false)) ORDER BY (a.address=addr) DESC LIMIT 1) o ON true
    LEFT JOIN LATERAL (SELECT b.id FROM (SELECT id,created_at,rules FROM mailboxes WHERE workspace_id=x.workspace_id AND domain_id=d.id AND expires_at IS NULL AND rules<>'[]'::jsonb ORDER BY created_at,id LIMIT 64) b WHERE plan IS NULL AND o.owner IS NULL AND EXISTS (
      SELECT 1 FROM jsonb_array_elements_text(b.rules) t(pattern) WHERE addr LIKE replace(replace(replace(replace(pattern,'!','!!'),'%','!%'),'_','!_'),'*','%') ESCAPE '!') ORDER BY b.created_at,b.id LIMIT 1) rule ON true
    WHERE plan IS NULL OR pr.item IS NOT NULL AND NOT (pr.item->>'dropped')::boolean
  ), misses AS (SELECT * FROM routes WHERE NOT retired AND (item IS NULL OR item->>'tier'='default') AND owner IS NULL AND ruled IS NULL AND valid AND catch_all='create_mailbox' AND can_create),
  domain_budget AS MATERIALIZED (SELECT domain,50-count(created_at) AS slots
    FROM (SELECT DISTINCT domain FROM misses) d LEFT JOIN LATERAL (SELECT created_at FROM mailboxes b WHERE b.workspace_id=wid AND b.domain_id=d.domain AND b.origin='auto' AND b.created_at>now()-interval '1 hour' LIMIT 50) b ON true GROUP BY domain),
  candidates AS (SELECT r.*,row_number() OVER(PARTITION BY domain ORDER BY n) AS rank FROM misses r WHERE NOT EXISTS(SELECT 1 FROM misses earlier WHERE earlier.addr=r.base AND earlier.n<r.n)),
  boxes AS (INSERT INTO mailboxes(id,domain_id,address,workspace_id,origin)
    SELECT 'mbx_'||replace(gen_random_uuid()::text,'-',''),domain,addr,wid,'auto' FROM candidates JOIN domain_budget USING(domain) WHERE rank<=slots ORDER BY n
    LIMIT (CASE WHEN EXISTS(SELECT FROM candidates JOIN domain_budget USING(domain) WHERE rank<=slots) THEN (SELECT 50000-count(*) FROM (SELECT 1 FROM mailboxes WHERE workspace_id=wid AND origin='auto' LIMIT 50000) used) ELSE 0 END) RETURNING *
  ), addresses AS (INSERT INTO mailbox_addresses(workspace_id,address,mailbox_id,kind) SELECT workspace_id,address,id,'primary' FROM boxes),
  resolved AS (SELECT r.addr,r.retired,CASE WHEN r.retired THEN NULL WHEN r.owner IS NOT NULL THEN CASE WHEN r.receives THEN r.owner END ELSE coalesce(base.id,r.ruled,exact.id) END AS box
    FROM routes r LEFT JOIN boxes exact ON exact.address=r.addr LEFT JOIN (boxes base JOIN misses earlier ON earlier.addr=base.address) ON base.address=r.base AND earlier.n<r.n
    WHERE r.item IS NULL OR r.item->>'tier'='default'
    UNION ALL SELECT r.addr,r.retired,CASE WHEN NOT r.retired THEN ref.id END FROM routes r LEFT JOIN LATERAL jsonb_array_elements_text(r.item->'inboxes') ref(id) ON true WHERE r.item->>'tier'<>'default' OR (r.item->'added') ? ref.id),
  unrouted AS (INSERT INTO mail_unrouted(workspace_id,message_id,address) SELECT x.workspace_id,x.id,r.addr FROM target x,resolved r WHERE NOT r.retired AND x.lifecycle<>'ephemeral' AND (r.box IS NULL OR EXISTS(SELECT FROM routes cap WHERE cap.addr=r.addr AND cap.item @> '{"limited":true}')) ON CONFLICT DO NOTHING),
  locked_inboxes AS MATERIALIZED (SELECT s.*,b.expires_at,b.quota_messages,b.quota_bytes FROM inbox_state s JOIN mailboxes b ON b.id=s.inbox_id WHERE s.workspace_id=wid AND s.inbox_id IN(SELECT box FROM resolved) ORDER BY s.inbox_id FOR UPDATE OF s),
  -- Aggregate once per box even when many recipient addresses resolve to the same inbox.
  flags AS (SELECT re.box,bool_or((rr.item->>'junk')::boolean) AS junk,
    (array_agg(DISTINCT label ORDER BY label) FILTER(WHERE label IS NOT NULL))[1:10] AS labels FROM routes rr JOIN resolved re USING(addr)
    LEFT JOIN LATERAL jsonb_array_elements_text(rr.item->'labels') label ON true WHERE rr.item?'labels' GROUP BY re.box),
  added AS (INSERT INTO mailbox_messages(mailbox_id,message_id,workspace_id,thread_id,direction,read,received_at,labels,held_reason,reply_author_verified)
    SELECT DISTINCT r.box,x.id,x.workspace_id,x.thread_id,'inbound',false,x.received_at,array_remove(ARRAY[CASE WHEN b.require_dmarc THEN 'unverified' END,CASE WHEN coalesce(flags.junk,is_spam) AND plan IS NOT NULL THEN 'spam' WHEN is_spam AND NOT flags.junk THEN 'guard-allowed' END],NULL)||coalesce(flags.labels,ARRAY[]::text[]),CASE WHEN state.expires_at<=statement_timestamp() THEN 'expired' WHEN state.messages>=state.quota_messages OR state.bytes+x.size_bytes>state.quota_bytes THEN 'quota' END,coalesce((msg->>'reply_author_verified')::boolean,false)
    FROM target x CROSS JOIN resolved r LEFT JOIN flags ON flags.box=r.box LEFT JOIN locked_inboxes state ON state.inbox_id=r.box LEFT JOIN mailboxes b ON b.id=r.box AND (dmarc IS DISTINCT FROM 'PASS') WHERE r.box IS NOT NULL AND NOT EXISTS(SELECT FROM inbox_vanished v WHERE v.inbox_id=r.box AND v.message_id=x.id AND NOT EXISTS(SELECT FROM mailbox_messages live WHERE live.mailbox_id=r.box AND live.message_id=x.id)) ON CONFLICT DO NOTHING RETURNING *),
  counters AS (UPDATE inbox_state s SET messages=s.messages+1,bytes=s.bytes+coalesce(x.size_bytes,0),held=s.held+(a.held_reason IS NOT NULL)::int,held_since=coalesce(s.held_since,CASE WHEN a.held_reason IS NOT NULL THEN now() END) FROM added a JOIN target x ON x.id=a.message_id WHERE s.inbox_id=a.mailbox_id RETURNING s.inbox_id,s.held),
  summaries AS (INSERT INTO mailbox_threads AS t(mailbox_id,thread_id,workspace_id,message_count,unread_count,last_message_at,last_inbound_at,spam,labels)
    SELECT a.mailbox_id,x.thread_id,x.workspace_id,1,1,x.received_at,x.received_at,('spam'=ANY(a.labels) OR (plan IS NULL AND x.spam)),a.labels FROM target x JOIN added a ON a.message_id=x.id WHERE a.held_reason IS NULL ORDER BY a.mailbox_id
    ON CONFLICT(mailbox_id,thread_id) DO UPDATE SET message_count=t.message_count+1,unread_count=t.unread_count+1,last_message_at=greatest(t.last_message_at,excluded.last_message_at),last_inbound_at=greatest(t.last_inbound_at,excluded.last_inbound_at),archived=false RETURNING mailbox_id),
  -- Route eligibility is per recipient, not per message. A received event from a different
  -- recipient must not resurrect a held route. Reopens can encounter an existing membership.
  held_routes AS MATERIALIZED (SELECT DISTINCT r.addr FROM resolved r JOIN target x ON true
    WHERE EXISTS(SELECT FROM added a WHERE a.mailbox_id=r.box AND a.held_reason IS NOT NULL)
       OR EXISTS(SELECT FROM mailbox_messages m WHERE m.mailbox_id=r.box AND m.message_id=x.id AND m.held_reason IS NOT NULL)),
  hook_routes AS MATERIALIZED (SELECT r.* FROM routes r WHERE NOT r.retired AND jsonb_array_length(r.item->'webhooks')>0 AND NOT EXISTS(SELECT FROM held_routes held WHERE held.addr=r.addr)
    AND NOT EXISTS(SELECT FROM routed_before p WHERE p.envelope_to ? r.addr)),
  done AS (UPDATE mail_receipts SET status='processed',processed_at=now(),routing=CASE WHEN plan IS NOT NULL THEN mail_routing_trace(jsonb_set(plan,'{recipients}',(
      SELECT jsonb_agg(CASE WHEN h.addr IS NOT NULL AND jsonb_array_length(p.item->'webhooks')>0 THEN p.item||jsonb_build_object('webhooks','[]'::jsonb,'warnings',(p.item->'warnings')||'"An inbox on this route held the delivery."'::jsonb) ELSE p.item END ORDER BY p.n)
      FROM jsonb_array_elements(plan->'recipients') WITH ORDINALITY p(item,n) LEFT JOIN held_routes h ON h.addr=p.item->>'address'))) END,
    dropped_recipients=(SELECT count(DISTINCT addr) FROM resolved WHERE retired),error=CASE WHEN EXISTS(SELECT FROM resolved WHERE retired) THEN 'EPHEMERAL_RETIRED' END WHERE workspace_id=wid AND ses_message_id=(msg->>'ses_message_id') AND EXISTS(SELECT FROM delivery)),
  items AS MATERIALIZED (SELECT workspace_id,'message.stored' AS type,NULL::text AS mailbox_id,thread_id,id AS message_id,jsonb_strip_nulls(jsonb_build_object('contactId',c.contact_id,'clearedSuppressionReason',c.suppression_reason)) AS data,1 AS ord FROM stored s LEFT JOIN cleared c ON c.message_id=s.id
    UNION ALL SELECT workspace_id,'address.created',id,NULL,NULL,'{"origin":"auto"}'::jsonb,2 FROM boxes
    UNION ALL SELECT x.workspace_id,CASE WHEN 'spam'=ANY(a.labels) THEN 'message.junk' ELSE 'message.received' END,a.mailbox_id,x.thread_id,x.id,jsonb_build_object('spam',x.spam,'automated',x.automated,'dmarc',dmarc::text),3
    FROM target x JOIN added a ON a.message_id=x.id JOIN summaries s ON s.mailbox_id=a.mailbox_id WHERE NOT ('unverified'=ANY(a.labels)) AND (NOT is_spam OR plan IS NOT NULL)
    UNION ALL SELECT x.workspace_id,CASE WHEN is_spam THEN 'message.junk' ELSE 'message.received' END,NULL,x.thread_id,x.id,'{}'::jsonb,3 FROM target x
    WHERE EXISTS(SELECT FROM hook_routes) AND NOT EXISTS(SELECT FROM added WHERE held_reason IS NULL AND NOT ('unverified'=ANY(labels)))
    UNION ALL SELECT a.workspace_id,'message.held',a.mailbox_id,a.thread_id,a.message_id,jsonb_build_object('reason',a.held_reason),4 FROM added a WHERE held_reason IS NOT NULL
    UNION ALL SELECT a.workspace_id,'inbox.quota_exceeded',a.mailbox_id,NULL,NULL,'{}'::jsonb,5 FROM added a JOIN counters s ON s.inbox_id=a.mailbox_id WHERE s.held=1 AND a.held_reason='quota'), lanes AS (
    INSERT INTO mailbox_write_lanes(workspace_id,lane) SELECT DISTINCT workspace_id,'events' FROM items ORDER BY workspace_id
    ON CONFLICT(workspace_id,lane) DO UPDATE SET lane=excluded.lane RETURNING workspace_id
  ), events AS (INSERT INTO mailbox_events(workspace_id,type,mailbox_id,thread_id,message_id,data)
    SELECT workspace_id,type,mailbox_id,thread_id,message_id,CASE WHEN msg#>>'{verdicts,simulated}'='true' THEN data||'{"simulated":true}' ELSE data END FROM items JOIN lanes USING(workspace_id) ORDER BY workspace_id,ord RETURNING *
  ), subscribed AS (SELECT e.workspace_id,e.seq,e.type,h.id FROM events e
    CROSS JOIN LATERAL (SELECT id,event_types,mailbox_ids,junk,format,include FROM mailbox_webhooks WHERE workspace_id=e.workspace_id AND event_types<>'[]' ORDER BY paused,id LIMIT 64) h
    WHERE (e.mailbox_id IS NOT NULL OR e.type NOT IN ('message.received','message.junk')) AND (h.event_types ? e.type OR e.type='message.junk' AND h.event_types ? 'message.received') AND (e.type<>'message.junk' OR h.junk='include') AND (NOT is_spam OR h.junk='include' OR (e.type='message.stored' AND h.format='bane' AND h.include='[]')) AND (h.mailbox_ids IS NULL OR (e.type<>'message.stored' AND h.mailbox_ids ? e.mailbox_id))),
  routed AS (SELECT DISTINCT ON (ref.id,act->>'ritualAction') ref.id,e.seq,e.workspace_id,r.addr,r.item->>'route' AS route,coalesce((r.item->>'junk')::boolean,e.type='message.junk') AS junk,act FROM hook_routes r CROSS JOIN jsonb_array_elements_text(r.item->'webhooks') ref(id)
    LEFT JOIN LATERAL jsonb_array_elements(r.item->'actions'->ref.id) act ON true
    JOIN events e ON e.type IN ('message.received','message.junk') ORDER BY ref.id,act->>'ritualAction',EXISTS(SELECT FROM subscribed s WHERE s.id=ref.id AND s.seq=e.seq) DESC,(r.item->'inboxes' ? e.mailbox_id) DESC NULLS LAST,e.seq,r.n),
  subscriptions AS (SELECT h.workspace_id,seq,jsonb_agg(CASE WHEN g.ids IS NOT NULL THEN (CASE WHEN jsonb_typeof(hook)='object' THEN hook ELSE jsonb_build_object('id',hook,'subscription',true) END)||jsonb_build_object('grants',g.ids) ELSE hook END) AS hooks FROM (
    SELECT s.workspace_id,s.seq,to_jsonb(s.id) AS hook FROM subscribed s WHERE NOT EXISTS(SELECT FROM routed r WHERE r.id=s.id AND s.type IN ('message.received','message.junk'))
    UNION ALL SELECT workspace_id,seq,jsonb_build_object('id',id,'recipient',addr,'route',route,'junk',junk)||coalesce(act,'{}'::jsonb) FROM routed) h
    LEFT JOIN LATERAL (SELECT jsonb_agg(DISTINCT gid) AS ids FROM (
      SELECT grant_id AS gid FROM mail_grant_objects WHERE workspace_id=h.workspace_id AND ((kind='endpoint' AND resource=coalesce(hook->>'id',hook#>>'{}')) OR (kind='route' AND resource=hook->>'route'))
      UNION ALL SELECT jsonb_array_elements_text(hook->'grants')) deps) g ON true GROUP BY h.workspace_id,seq),
  queued AS (INSERT INTO jobs(id,type,workspace_id,payload) SELECT 'job_'||gen_random_uuid(),'mailbox.fanout',workspace_id,jsonb_object_agg(seq::text,hooks) FROM subscriptions GROUP BY workspace_id RETURNING 1),
  owned_files AS (DELETE FROM mail_candidate_uploads u USING stored s WHERE u.batch=split_part(file_items->0->>'storageKey','/',-2) AND u.workspace_id=s.workspace_id AND u.message_id=s.id AND u.keys[1]=file_items->0->>'storageKey')
  SELECT (SELECT count(*)::int FROM queued),(SELECT jsonb_agg(jsonb_build_object('bid',a.mailbox_id,'mid',a.message_id,'seq',e.seq)) FROM added a JOIN locked_inboxes l ON l.inbox_id=a.mailbox_id LEFT JOIN events e ON e.mailbox_id=a.mailbox_id AND e.message_id=a.message_id AND e.type IN ('message.received','message.junk','message.held')) INTO queued_count,published;
 -- Claim and store are separate snapshots. Never acknowledge forever retention if the
 -- new owner appeared after the storage decision (including during a rolling deploy).
 IF EXISTS(SELECT FROM jsonb_to_recordset(published) p(bid text,mid text) JOIN mailboxes b ON b.id=p.bid AND b.workspace_id=wid JOIN mail_messages m ON m.id=p.mid WHERE b.retention_mode='forever' AND m.lifecycle<>'kept') THEN
  RAISE EXCEPTION 'Inbox retention changed; reclaim receipt' USING ERRCODE='40001';
 END IF;
 PERFORM mail_inbox_cursor(wid,published);
 wait_ms:=extract(epoch FROM locked-started)*1000; hold_ms:=extract(epoch FROM clock_timestamp()-locked)*1000; RETURN NEXT;
END $$;

-- Agent inboxes (kind='inbox', persistent ones included) per workspace: 50,000, was 1,000. The 60 creates a minute stay.
-- 145's create_managed_inbox, renamed by 149, otherwise unchanged.
CREATE OR REPLACE FUNCTION create_managed_inbox_checked(p jsonb) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE wid text:=p->>'wid'; req jsonb:=p->'input'; bid text:=p->>'id'; actor_id text:=p->>'actor'; d mailbox_domains; existing mailboxes; addr text; local text; host text; used_count integer; expires timestamptz:=now()+make_interval(secs=>(req->>'ttlSeconds')::int); deadline timestamptz:=expires+make_interval(hours=>(req->>'graceHours')::int);
BEGIN
 INSERT INTO mailbox_write_lanes(workspace_id,lane) VALUES(wid,'address') ON CONFLICT(workspace_id,lane) DO UPDATE SET lane=excluded.lane WHERE false;
 SELECT * INTO existing FROM mailboxes WHERE workspace_id=wid AND client_id=req->>'clientId';
 IF FOUND THEN
  IF existing.create_request<>req OR (NOT (p->>'admin')::boolean AND existing.created_by<>actor_id) THEN RETURN jsonb_build_object('error','IDEMPOTENCY_CONFLICT'); END IF;
  IF existing.expires_at<=now() THEN RETURN jsonb_build_object('error','INBOX_GONE'); END IF;
  RETURN jsonb_build_object('inbox',inbox_view(existing),'replay',true);
 END IF;
 INSERT INTO api_request_budgets AS b(workspace_id,key_id,window_start,used) VALUES(wid,'inbox-create:'||wid,date_trunc('minute',now()),1) ON CONFLICT(workspace_id,key_id) DO UPDATE SET used=CASE WHEN b.window_start=excluded.window_start THEN least(61,b.used+1) ELSE 1 END,window_start=excluded.window_start RETURNING used INTO used_count;
 IF used_count>60 THEN RETURN jsonb_build_object('error','INBOX_CREATE_RATE'); END IF;
 IF (SELECT count(*) FROM (SELECT 1 FROM mailboxes WHERE workspace_id=wid AND kind='inbox' LIMIT 50000)s)>=50000 THEN RETURN jsonb_build_object('error','EPHEMERAL_INBOX_LIMIT'); END IF;
 IF req->>'type'='sandbox' THEN
  host:=p->>'sandboxHost';
  INSERT INTO mailbox_domains(id,workspace_id,domain_id,name,region,status,catch_all) VALUES('virtual_'||host,wid,'virtual_'||host,host,'sandbox','disabled','store') ON CONFLICT(workspace_id,name) DO NOTHING;
  SELECT * INTO STRICT d FROM mailbox_domains WHERE workspace_id=wid AND name=host AND status='disabled';
 ELSE
 SELECT m.* INTO d FROM mailbox_domains m WHERE m.workspace_id=wid AND m.status IN ('active','waiting_for_mx','provisioning') AND (req->>'domain' IS NULL OR coalesce(m.receiving_host,m.name)=req->>'domain') AND (NOT (p->>'hosted')::boolean OR (m.receiving_host IS NOT NULL AND EXISTS(SELECT FROM domain_claims dc JOIN provider_connections pc ON pc.id=dc.connection_id AND pc.workspace_id=dc.workspace_id AND pc.state='ready' JOIN operation_domains o ON o.workspace_id=dc.workspace_id AND o.name=dc.name WHERE o.id=m.domain_id AND dc.workspace_id=wid AND (dc.sending_state IN ('verified','lost') OR dc.receiving_state<>'off') AND (o.region=pc.region OR (pc.kind='shared' AND m.region='us-east-2' AND m.status='active' AND dc.receiving_state IN ('active','lost')))))) ORDER BY (m.status='active') DESC,m.created_at,m.id LIMIT 1 FOR SHARE OF m;
 IF NOT FOUND THEN RETURN jsonb_build_object('error','RECEIVING_DOMAIN_REQUIRED'); END IF;
 host:=coalesce(d.receiving_host,d.name);
 IF d.status<>'active' THEN RETURN jsonb_build_object('error','RECEIVING_NOT_ACTIVE','domain',host,'domainId',d.domain_id,'mx',host||' MX 10 inbound-smtp.'||d.region||'.amazonaws.com'); END IF;
 END IF;
 IF NOT coalesce((p->>'manageAddress')::boolean,false) AND d.catch_all='create_mailbox' THEN RETURN jsonb_build_object('error','ADMIN_REQUIRED','domain',host); END IF;
 FOR local IN SELECT jsonb_array_elements_text(p->'locals') LOOP
  addr:=local||'@'||host;
  IF local IN ('admin','administrator','postmaster','hostmaster','webmaster','security','abuse','root') THEN RETURN jsonb_build_object('error','ADDRESS_RESERVED'); END IF;
  IF NOT coalesce((p->>'manageAddress')::boolean,false) AND (req->>'localPart' IS NOT NULL OR EXISTS (
    SELECT FROM mail_routes r WHERE r.workspace_id=wid AND r.domain_id=d.id AND r.enabled AND
      (r.match=addr OR position('*' IN r.match)>0 AND addr LIKE replace(replace(replace(replace(r.match,'!','!!'),'%','!%'),'_','!_'),'*','%') ESCAPE '!')
  ) OR EXISTS (SELECT FROM mailboxes m CROSS JOIN LATERAL jsonb_array_elements_text(m.rules) AS r(pattern) WHERE m.workspace_id=wid AND m.domain_id=d.id AND m.expires_at IS NULL AND m.rules<>'[]' AND addr LIKE replace(replace(replace(replace(r.pattern,'!','!!'),'%','!%'),'_','!_'),'*','%') ESCAPE '!')) THEN addr:=NULL; CONTINUE; END IF;
  IF EXISTS(SELECT FROM mail_retired_addresses WHERE workspace_id=wid AND address=addr AND until>now()) THEN IF req->>'localPart' IS NOT NULL THEN RETURN jsonb_build_object('error','ADDRESS_RETIRED','domain',host);END IF;
  ELSIF NOT EXISTS(SELECT FROM mailbox_addresses WHERE workspace_id=wid AND address=addr) THEN EXIT; END IF;
  addr:=NULL;
 END LOOP;
 IF addr IS NULL THEN RETURN jsonb_build_object('error','ADDRESS_TAKEN','domain',host); END IF;
 IF req->>'type'='persistent' THEN expires:=NULL; deadline:=NULL; END IF;
 INSERT INTO mailboxes(id,workspace_id,domain_id,address,display_name,metadata,kind,retention_mode,expires_at,delete_after,quota_messages,quota_bytes,send_limits,client_id,created_by,create_request)
 VALUES(bid,wid,d.id,addr,req->>'name',req->'metadata','inbox',CASE WHEN req->>'type'='persistent' THEN 'forever' ELSE 'ephemeral' END,expires,deadline,(req#>>'{limits,messages}')::int,(req#>>'{limits,bytes}')::bigint,jsonb_build_object('perDay',CASE WHEN (req#>>'{send,enabled}')::boolean THEN (req#>>'{send,perDay}')::int ELSE 0 END),req->>'clientId',actor_id,req);
 INSERT INTO mailbox_addresses(workspace_id,address,mailbox_id,kind) VALUES(wid,addr,bid,'primary');
 INSERT INTO inbox_state(inbox_id,workspace_id) VALUES(bid,wid);
 IF p?'key' THEN INSERT INTO mailbox_keys(id,workspace_id,name,hash,prefix,mailbox_ids,permissions,expires_at) VALUES(p#>>'{key,id}',wid,req#>>'{credential,name}',p#>>'{key,hash}',p#>>'{key,prefix}',jsonb_build_array(bid),req#>'{credential,permissions}',deadline); END IF;
 PERFORM inbox_event(wid,bid,'inbox.created');
 SELECT * INTO existing FROM mailboxes WHERE id=bid;
 RETURN jsonb_build_object('inbox',inbox_view(existing),'replay',false);
END $$;
