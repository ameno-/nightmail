SET LOCAL lock_timeout='2s';

-- Maintain exact unread count on inbox_state so inbox_view() never scans mailbox_messages.
-- Existing rows stay NULL until migration 410 backfills them; inbox_view() falls back to the
-- live count while unread IS NULL so an inbox never shows a wrong zero during rollout.
ALTER TABLE inbox_state ADD COLUMN IF NOT EXISTS unread integer;

CREATE OR REPLACE FUNCTION inbox_view(b mailboxes) RETURNS jsonb LANGUAGE sql STABLE AS $$
 SELECT jsonb_build_object('id',b.id,'kind','inbox','retention',jsonb_build_object('mode',b.retention_mode),'type',b.create_request->>'type','address',b.address,'domain',split_part(b.address,'@',2),'name',b.display_name,'metadata',b.metadata,'clientId',b.client_id,'createdAt',to_char(b.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'expiresAt',to_char(b.expires_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'deleteAfter',to_char(b.delete_after AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'status',CASE WHEN b.delete_after<=now() THEN 'deleting' WHEN b.expires_at<=now() THEN 'expired' ELSE 'active' END,'limits',jsonb_build_object('messages',b.quota_messages,'bytes',b.quota_bytes),'send',jsonb_build_object('enabled',(b.send_limits->>'perDay')::int>0,'perDay',(b.send_limits->>'perDay')::int,'replyOnly',true),'usage',jsonb_build_object('messages',s.messages,'bytes',s.bytes,'held',s.held,'unread',coalesce(s.unread,(SELECT count(*) FROM mailbox_messages WHERE mailbox_id=b.id AND NOT read AND held_reason IS NULL)),'lastMessageAt',(SELECT max(received_at) FROM mailbox_messages WHERE mailbox_id=b.id))) FROM inbox_state s WHERE s.inbox_id=b.id AND s.workspace_id=b.workspace_id
$$;

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
 INSERT INTO inbox_state(inbox_id,workspace_id,unread) VALUES(bid,wid,0);
 IF p?'key' THEN INSERT INTO mailbox_keys(id,workspace_id,name,hash,prefix,mailbox_ids,permissions,expires_at) VALUES(p#>>'{key,id}',wid,req#>>'{credential,name}',p#>>'{key,hash}',p#>>'{key,prefix}',jsonb_build_array(bid),req#>'{credential,permissions}',deadline); END IF;
 PERFORM inbox_event(wid,bid,'inbox.created');
 SELECT * INTO existing FROM mailboxes WHERE id=bid;
 RETURN jsonb_build_object('inbox',inbox_view(existing),'replay',false);
END $$;

CREATE OR REPLACE FUNCTION inbox_adopt(bid text) RETURNS integer LANGUAGE plpgsql AS $$
DECLARE base bigint; n_filed int;
BEGIN
 INSERT INTO inbox_state(inbox_id,workspace_id,messages,bytes,held,unread)
  SELECT b.id,b.workspace_id,
   (SELECT count(*) FROM mailbox_messages WHERE mailbox_id=b.id),
   (SELECT coalesce(sum(m.size_bytes),0) FROM mailbox_messages l JOIN mail_messages m ON m.id=l.message_id WHERE l.mailbox_id=b.id),
   (SELECT count(*) FROM mailbox_messages WHERE mailbox_id=b.id AND held_reason IS NOT NULL),
   (SELECT count(*) FROM mailbox_messages WHERE mailbox_id=b.id AND NOT read AND held_reason IS NULL)
  FROM mailboxes b WHERE b.id=bid ON CONFLICT(inbox_id) DO NOTHING RETURNING modseq INTO base;
 IF base IS NULL THEN RETURN NULL; END IF;
 WITH ordered AS MATERIALIZED (
   SELECT l.message_id,l.read,l.received_at,l.held_reason,l.inbox_seq,
    CASE WHEN t.trashed_at IS NOT NULL THEN 'trash' WHEN l.direction='outbound' THEN 'sent'
     WHEN t.spam OR 'spam'=ANY(l.labels) OR (m.spam AND NOT 'guard-allowed'=ANY(l.labels)) THEN 'junk'
     WHEN t.archived THEN 'archive' ELSE 'inbox' END AS dest,coalesce(t.starred,false) AS starred
   FROM mailbox_messages l JOIN mail_messages m ON m.id=l.message_id LEFT JOIN mailbox_threads t ON t.mailbox_id=bid AND t.thread_id=m.thread_id
   WHERE l.mailbox_id=bid AND l.modseq IS NULL ORDER BY l.received_at,l.message_id),
  filed AS MATERIALIZED (SELECT o.*,base+row_number() OVER (ORDER BY o.received_at,o.message_id) AS stamp,
   coalesce(o.inbox_seq,nextval(pg_get_serial_sequence('mailbox_events','seq'))) AS seq FROM ordered o),
  placed AS MATERIALIZED (SELECT f.*,fo.uid_next-1+row_number() OVER (PARTITION BY f.dest ORDER BY f.stamp) AS uid
   FROM filed f JOIN inbox_folders fo ON fo.inbox_id=bid AND fo.role=f.dest WHERE f.held_reason IS NULL),
  entries AS (INSERT INTO inbox_entries(inbox_id,role,uid,message_id,modseq,internal_date) SELECT bid,dest,uid,message_id,stamp,received_at FROM placed),
  folders AS (UPDATE inbox_folders fo SET uid_next=fo.uid_next+p.n,total=fo.total+p.n,unseen=fo.unseen+p.unseen,highest_modseq=greatest(fo.highest_modseq,p.top)
   FROM (SELECT dest,count(*) n,count(*) FILTER (WHERE NOT read) unseen,max(stamp) top FROM placed GROUP BY dest) p WHERE fo.inbox_id=bid AND fo.role=p.dest),
  members AS (UPDATE mailbox_messages l SET modseq=f.stamp,flags=CASE WHEN f.starred THEN 1 ELSE 0 END,inbox_seq=f.seq
   FROM filed f WHERE l.mailbox_id=bid AND l.message_id=f.message_id)
 SELECT count(*) INTO n_filed FROM filed;
 UPDATE inbox_state SET modseq=base+n_filed WHERE inbox_id=bid AND n_filed>0;
 RETURN n_filed;
END $$;

CREATE OR REPLACE FUNCTION inbox_file_delivery(bid text, mid text, delivery_seq bigint, legacy boolean DEFAULT false) RETURNS void LANGUAGE plpgsql AS $$
DECLARE membership mailbox_messages; stamp bigint; dest text; starred boolean; message_size int;
BEGIN
 PERFORM FROM inbox_state WHERE inbox_id=bid FOR UPDATE;
 IF NOT FOUND THEN RETURN; END IF;
 SELECT * INTO membership FROM mailbox_messages WHERE mailbox_id=bid AND message_id=mid;
 IF NOT FOUND OR membership.modseq IS NOT NULL THEN RETURN; END IF;
 SELECT CASE WHEN legacy AND t.trashed_at IS NOT NULL THEN 'trash'
             WHEN membership.direction='outbound' THEN 'sent'
             WHEN (legacy AND t.spam) OR 'spam'=ANY(membership.labels) OR (m.spam AND NOT 'guard-allowed'=ANY(membership.labels)) THEN 'junk'
             WHEN legacy AND t.archived THEN 'archive' ELSE 'inbox' END,
        legacy AND coalesce(t.starred,false),coalesce(m.size_bytes,0) INTO dest,starred,message_size
 FROM mail_messages m LEFT JOIN mailbox_threads t ON t.mailbox_id=bid AND t.thread_id=m.thread_id WHERE m.id=mid;
 UPDATE inbox_state SET modseq=modseq+1,messages=messages+(membership.direction='outbound')::int,
   bytes=bytes+CASE WHEN membership.direction='outbound' THEN message_size ELSE 0 END,
   unread=unread+CASE WHEN NOT legacy AND NOT membership.read AND membership.held_reason IS NULL THEN 1 ELSE 0 END
 WHERE inbox_id=bid RETURNING modseq INTO stamp;
 UPDATE mailbox_messages SET modseq=stamp,flags=CASE WHEN starred THEN 1 ELSE 0 END,
   inbox_seq=coalesce(inbox_seq,delivery_seq,nextval(pg_get_serial_sequence('mailbox_events','seq')))
 WHERE mailbox_id=bid AND message_id=mid;
 IF membership.held_reason IS NULL THEN
   -- A rolling deploy can deliver to an old inbox before its backfill page has run.
   IF NOT EXISTS(SELECT FROM inbox_folders WHERE inbox_id=bid AND role=dest) THEN PERFORM inbox_seed_folders(bid); END IF;
   PERFORM inbox_add_entry(bid,mid,dest,stamp,membership.read,membership.received_at);
 END IF;
END $$;

CREATE OR REPLACE FUNCTION inbox_apply_mutation(wid text, bid text, mid text, op text, p jsonb, refresh boolean DEFAULT true) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE m mailbox_messages; ent inbox_entries; stamp bigint; source text:=p->>'source'; dest text:=p->>'folder';
 seen boolean; bits int; bit_names text[]:=ARRAY['flagged','answered','draft','forwarded','junk','notJunk','mdnSent']; i int; allocated bigint; gone boolean:=false; keywords text[];
BEGIN
 PERFORM FROM inbox_state s JOIN mailboxes b ON b.id=s.inbox_id WHERE s.workspace_id=wid AND s.inbox_id=bid AND (b.delete_after IS NULL OR b.delete_after>statement_timestamp()) FOR UPDATE OF s;
 IF NOT FOUND THEN RETURN '{"error":"NOT_FOUND"}'; END IF;
 SELECT * INTO m FROM mailbox_messages WHERE workspace_id=wid AND mailbox_id=bid AND message_id=mid;
 IF NOT FOUND THEN RETURN '{"error":"MESSAGE_GONE"}'; END IF;
 IF m.modseq>(p->>'ifModseq')::bigint THEN RETURN '{"error":"MODIFIED"}'; END IF;
 IF op IN ('move','copy','expunge') OR p?'deleted' THEN
  SELECT * INTO ent FROM inbox_entries WHERE inbox_id=bid AND message_id=mid AND (source IS NULL OR role=source) AND (p->>'uid' IS NULL OR uid=(p->>'uid')::bigint) ORDER BY role,uid LIMIT 1;
  IF NOT FOUND THEN RETURN '{"error":"MESSAGE_GONE"}'; END IF;
  IF EXISTS(SELECT FROM inbox_entries WHERE inbox_id=bid AND message_id=mid AND (source IS NULL OR role=source) AND (p->>'uid' IS NULL OR uid=(p->>'uid')::bigint) AND (role,uid)<>(ent.role,ent.uid)) THEN RETURN '{"error":"AMBIGUOUS_ENTRY"}'; END IF;
 END IF;
 seen:=coalesce((p->>'read')::boolean,m.read); bits:=m.flags;
 FOR i IN 1..array_length(bit_names,1) LOOP
  IF p?bit_names[i] THEN bits:=CASE WHEN (p->>bit_names[i])::boolean THEN bits|(1<<(i-1)) ELSE bits&(~(1<<(i-1))) END; END IF;
 END LOOP;
 keywords:=m.labels;
 IF p?'addLabels' OR p?'removeLabels' THEN
  SELECT ARRAY(SELECT DISTINCT lbl FROM unnest(m.labels||ARRAY(SELECT value FROM jsonb_array_elements_text(p->'addLabels') WHERE value NOT IN ('unverified','spam','guard-allowed'))) lbl WHERE NOT coalesce(p->'removeLabels' ? lbl,false) OR lbl IN ('unverified','spam','guard-allowed') ORDER BY lbl) INTO keywords;
  IF cardinality(keywords)>64 THEN RETURN '{"error":"LABEL_LIMIT"}'; END IF;
 END IF;
 UPDATE inbox_state SET modseq=modseq+1,
   unread=CASE WHEN unread IS NULL OR op='expunge' THEN unread ELSE greatest(unread+(NOT seen AND m.held_reason IS NULL)::int-(NOT m.read AND m.held_reason IS NULL)::int,0) END
 WHERE inbox_id=bid RETURNING modseq INTO stamp;
 IF op='flags' THEN
  UPDATE inbox_folders f SET highest_modseq=stamp,unseen=f.unseen+ CASE WHEN m.read=seen THEN 0 WHEN seen THEN -a.n ELSE a.n END
   FROM (SELECT role,count(*)::int n FROM inbox_entries WHERE inbox_id=bid AND message_id=mid AND (m.read<>seen OR bits<>m.flags OR keywords<>m.labels OR NOT p?'deleted' OR (role,uid)=(ent.role,ent.uid)) GROUP BY role)a
   WHERE f.inbox_id=bid AND f.role=a.role;
  UPDATE inbox_entries SET modseq=stamp,deleted=CASE WHEN (role,uid)=(ent.role,ent.uid) THEN coalesce((p->>'deleted')::boolean,deleted) ELSE deleted END
   WHERE inbox_id=bid AND message_id=mid AND (m.read<>seen OR bits<>m.flags OR keywords<>m.labels OR NOT p?'deleted' OR (role,uid)=(ent.role,ent.uid));
 ELSE
  IF op IN ('move','copy') THEN
   allocated:=inbox_add_entry(bid,mid,dest,stamp,seen,ent.internal_date);
   IF ent.deleted THEN UPDATE inbox_entries SET deleted=true WHERE inbox_id=bid AND role=dest AND uid=allocated; END IF;
  END IF;
  IF op IN ('move','expunge') THEN
   DELETE FROM inbox_entries WHERE inbox_id=bid AND (role,uid)=(ent.role,ent.uid);
   INSERT INTO inbox_vanished(inbox_id,role,uid,message_id,modseq) VALUES(bid,ent.role,ent.uid,mid,stamp);
   UPDATE inbox_folders SET highest_modseq=stamp,total=total-1,unseen=unseen-(NOT m.read)::int WHERE inbox_id=bid AND role=ent.role;
   IF op='expunge' AND NOT EXISTS(SELECT FROM inbox_entries WHERE inbox_id=bid AND message_id=mid) THEN
    DELETE FROM mailbox_messages WHERE mailbox_id=bid AND message_id=mid;
    UPDATE inbox_state SET messages=greatest(messages-1,0),bytes=greatest(bytes-coalesce((SELECT size_bytes FROM mail_messages WHERE id=mid),0),0),
      held=greatest(held-(m.held_reason IS NOT NULL)::int,0),
      unread=CASE WHEN unread IS NULL THEN NULL ELSE greatest(unread-(NOT m.read AND m.held_reason IS NULL)::int,0) END
    WHERE inbox_id=bid;
    INSERT INTO mail_gc_candidates(workspace_id,message_id) VALUES(wid,mid) ON CONFLICT DO NOTHING; gone:=true;
   ELSIF op='expunge' AND m.read<>seen THEN
    UPDATE inbox_state SET unread=CASE WHEN unread IS NULL THEN NULL ELSE greatest(unread+(NOT seen AND m.held_reason IS NULL)::int-(NOT m.read AND m.held_reason IS NULL)::int,0) END WHERE inbox_id=bid;
   END IF;
  END IF;
 END IF;
 IF NOT gone THEN UPDATE mailbox_messages SET modseq=stamp,flags=bits,read=seen,
   labels=keywords
   WHERE mailbox_id=bid AND message_id=mid; END IF;
 IF refresh AND m.held_reason IS NULL THEN PERFORM inbox_refresh_thread(bid,m.thread_id); END IF;
 RETURN jsonb_build_object('id',mid,'read',seen,'modseq',stamp::text,'uid',allocated,'removed',gone);
END $$;

CREATE OR REPLACE FUNCTION mailgw_append(w text, b text, f text, mid text, tid text, client_id text, subj text, sender text, txt text, dt timestamp with time zone, n integer, bucket text, k text, mime jsonb, fl text[]) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE v bigint; u bigint; s bigint; seen boolean:='\Seen'=ANY(fl); bits int:=0; labels text[]; i int; standard text[]:=ARRAY['\Flagged','\Answered','\Draft','$Forwarded','$Junk','$NotJunk','$MDNSent'];
BEGIN
 IF NOT inbox_lock_visible(w,b,true) THEN RETURN '{"error":"NOT_FOUND"}'; END IF;
 IF n>41943040 THEN RETURN '{"error":"TOO_LARGE"}'; END IF;
 SELECT uid_validity INTO STRICT v FROM inbox_folders WHERE inbox_id=b AND role=f;
 IF f='sent' AND client_id IS NOT NULL THEN SELECT e.uid INTO u FROM inbox_entries e JOIN mail_messages m ON m.id=e.message_id WHERE e.inbox_id=b AND e.role=f AND m.sender_mailbox_id=b AND m.message_id=client_id AND m.created_at>now()-interval '24 hours' LIMIT 1;
 IF FOUND THEN RETURN jsonb_build_object('validity',v,'pairs',jsonb_build_array(jsonb_build_array(1,u))); END IF; END IF;
 SELECT ARRAY(SELECT x FROM unnest(fl) x WHERE NOT x=ANY(standard) AND x NOT IN ('\Seen','\Deleted','unverified','spam','guard-allowed') AND x ~ '^[\x21\x23\x24\x26\x27\x2b-\x5b\x5e-\x7a\x7c-\x7e]{1,64}$') INTO labels;
 FOR i IN 1..7 LOOP IF standard[i]=ANY(fl) THEN bits:=bits|(1<<(i-1)); END IF; END LOOP;
 UPDATE inbox_state SET protocol_append_count=CASE WHEN protocol_append_window=date_trunc('minute',now()) THEN protocol_append_count+1 ELSE 1 END,protocol_append_window=date_trunc('minute',now()) WHERE inbox_id=b AND (protocol_append_window IS DISTINCT FROM date_trunc('minute',now()) OR protocol_append_count<300);IF NOT FOUND THEN RETURN '{"error":"RATE_LIMIT"}'; END IF;
 UPDATE inbox_state st SET messages=messages+1,bytes=bytes+n,modseq=modseq+1,unread=st.unread+(NOT seen)::int FROM mailboxes box WHERE st.inbox_id=b AND box.id=b AND (box.quota_messages IS NULL OR st.messages<box.quota_messages) AND (box.quota_bytes IS NULL OR st.bytes+n<=box.quota_bytes) RETURNING st.modseq INTO s;
 IF NOT FOUND THEN RETURN '{"error":"OVERQUOTA"}'; END IF;
 INSERT INTO mail_threads(id,workspace_id,subject,message_count,last_message_at) VALUES(tid,w,subj,1,dt);
 INSERT INTO mail_messages(id,workspace_id,thread_id,direction,lifecycle,subject,from_address,text,message_id,received_at,size_bytes,raw_bucket,raw_key,mime,verdicts) VALUES(mid,w,tid,'inbound','kept',subj,sender,txt,client_id,dt,n,bucket,k,mime,'{"origin":"client-append"}');
 INSERT INTO mailbox_messages(mailbox_id,message_id,workspace_id,thread_id,direction,read,received_at,modseq,flags,labels,inbox_seq) VALUES(b,mid,w,tid,'inbound',seen,dt,s,bits,labels,nextval(pg_get_serial_sequence('mailbox_events','seq')));
 INSERT INTO mailbox_threads(mailbox_id,thread_id,workspace_id,message_count,unread_count,last_message_at,last_inbound_at) VALUES(b,tid,w,1,(NOT seen)::int,dt,dt);
 u:=inbox_add_entry(b,mid,f,s,seen,dt);IF '\Deleted'=ANY(fl) THEN UPDATE inbox_entries SET deleted=true WHERE inbox_id=b AND role=f AND uid=u; END IF;
 RETURN jsonb_build_object('validity',v,'pairs',jsonb_build_array(jsonb_build_array(0,u)));
END $$;

CREATE OR REPLACE FUNCTION inbox_retention_batch(batch_size integer) RETURNS integer LANGUAGE plpgsql AS $$
DECLARE b mailboxes; candidate record; n int:=0; remaining int:=5000; removed int; removed_held int; removed_unread int;
BEGIN
 FOR candidate IN SELECT batch.id,batch.workspace_id FROM (SELECT id,workspace_id FROM mailboxes WHERE retention_mode='ephemeral' AND delete_after<=now() ORDER BY delete_after LIMIT least(batch_size,25)) batch ORDER BY workspace_id,id LOOP
  INSERT INTO mailbox_write_lanes(workspace_id,lane) VALUES(candidate.workspace_id,'ingest'),(candidate.workspace_id,'address') ON CONFLICT(workspace_id,lane) DO UPDATE SET lane=excluded.lane WHERE false;
  SELECT * INTO b FROM mailboxes WHERE id=candidate.id AND retention_mode='ephemeral' AND delete_after<=now() FOR UPDATE SKIP LOCKED; IF NOT FOUND THEN CONTINUE; END IF;
  WITH gone AS (DELETE FROM mailbox_messages WHERE mailbox_id=b.id AND message_id IN(SELECT message_id FROM mailbox_messages WHERE mailbox_id=b.id LIMIT remaining) RETURNING workspace_id,message_id,read,held_reason),
  gc AS (INSERT INTO mail_gc_candidates(workspace_id,message_id) SELECT workspace_id,message_id FROM gone ON CONFLICT DO NOTHING)
  SELECT count(*),count(*) FILTER(WHERE held_reason IS NOT NULL),count(*) FILTER(WHERE NOT read AND held_reason IS NULL) INTO removed,removed_held,removed_unread FROM gone;
  remaining:=remaining-removed;
  IF NOT EXISTS(SELECT FROM mailbox_messages WHERE mailbox_id=b.id) THEN
   INSERT INTO mail_retired_addresses SELECT workspace_id,address,now()+interval '30 days' FROM mailbox_addresses WHERE mailbox_id=b.id AND b.create_request->>'type'='sandbox' ON CONFLICT(workspace_id,address) DO UPDATE SET until=excluded.until;
   UPDATE mailbox_keys SET revoked_at=now() WHERE workspace_id=b.workspace_id AND mailbox_ids=jsonb_build_array(b.id) AND revoked_at IS NULL;
   DELETE FROM mailboxes WHERE id=b.id; PERFORM inbox_event(b.workspace_id,b.id,'inbox.deleted');
  ELSIF removed>0 THEN
   UPDATE inbox_state SET messages=greatest(messages-removed,0),held=greatest(held-removed_held,0),
     unread=CASE WHEN unread IS NULL THEN NULL ELSE greatest(unread-removed_unread,0) END
   WHERE inbox_id=b.id;
  END IF;
  n:=n+1; EXIT WHEN remaining=0;
 END LOOP;
 RETURN n;
END $$;
