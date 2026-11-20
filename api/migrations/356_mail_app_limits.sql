SET LOCAL lock_timeout='2s';
-- Mail apps get the API's limits. A quota is only what an inbox sets: NULL means none for a client APPEND too, as for
-- received mail (177 had defaulted it to 100,000 messages and 1 GiB). An APPEND may be 40 MiB, the most received mail
-- can be. A keyword is any RFC 3501 atom: printable ASCII but ( ) { % * " \ ] and space (src/mail-gateway.ts KEYWORD).
CREATE OR REPLACE FUNCTION mailgw_append(w text,b text,f text,mid text,tid text,client_id text,subj text,sender text,txt text,dt timestamptz,n int,bucket text,k text,mime jsonb,fl text[]) RETURNS jsonb LANGUAGE plpgsql AS $$
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
 UPDATE inbox_state st SET messages=messages+1,bytes=bytes+n,modseq=modseq+1 FROM mailboxes box WHERE st.inbox_id=b AND box.id=b AND (box.quota_messages IS NULL OR st.messages<box.quota_messages) AND (box.quota_bytes IS NULL OR st.bytes+n<=box.quota_bytes) RETURNING st.modseq INTO s;
 IF NOT FOUND THEN RETURN '{"error":"OVERQUOTA"}'; END IF;
 INSERT INTO mail_threads(id,workspace_id,subject,message_count,last_message_at) VALUES(tid,w,subj,1,dt);
 INSERT INTO mail_messages(id,workspace_id,thread_id,direction,lifecycle,subject,from_address,text,message_id,received_at,size_bytes,raw_bucket,raw_key,mime,verdicts) VALUES(mid,w,tid,'inbound','kept',subj,sender,txt,client_id,dt,n,bucket,k,mime,'{"origin":"client-append"}');
 INSERT INTO mailbox_messages(mailbox_id,message_id,workspace_id,thread_id,direction,read,received_at,modseq,flags,labels,inbox_seq) VALUES(b,mid,w,tid,'inbound',seen,dt,s,bits,labels,nextval(pg_get_serial_sequence('mailbox_events','seq')));
 INSERT INTO mailbox_threads(mailbox_id,thread_id,workspace_id,message_count,unread_count,last_message_at,last_inbound_at) VALUES(b,tid,w,1,(NOT seen)::int,dt,dt);
 u:=inbox_add_entry(b,mid,f,s,seen,dt);IF '\Deleted'=ANY(fl) THEN UPDATE inbox_entries SET deleted=true WHERE inbox_id=b AND role=f AND uid=u; END IF;
 RETURN jsonb_build_object('validity',v,'pairs',jsonb_build_array(jsonb_build_array(0,u)));
END $$;

CREATE OR REPLACE FUNCTION mailgw_mutate(w text,b text,src text,dst text,op text,uids bigint[],mode text,bits jsonb,labels text[]) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE e record; data jsonb; result jsonb; pairs jsonb:='[]'; validity bigint; threads text[]:='{}';
BEGIN
 IF op='expunge' THEN PERFORM inbox_lock_ingest(w); END IF;
 IF NOT inbox_lock_visible(w,b,true) THEN RETURN '{"error":"NOT_FOUND"}'; END IF;
 SELECT uid_validity INTO STRICT validity FROM inbox_folders WHERE inbox_id=b AND role=coalesce(dst,src);
 FOR e IN SELECT i.uid,i.deleted,i.message_id,l.labels,l.thread_id,l.held_reason FROM inbox_entries i JOIN mailbox_messages l ON l.mailbox_id=b AND l.message_id=i.message_id WHERE i.inbox_id=b AND i.role=src AND (uids IS NULL OR i.uid=ANY(uids)) AND (op<>'expunge' OR i.deleted) ORDER BY i.uid LOOP
  data:=jsonb_build_object('source',src,'uid',e.uid,'folder',dst);
  IF op='flags' THEN data:=data||bits||jsonb_build_object('addLabels',CASE WHEN mode='remove' THEN ARRAY[]::text[] ELSE labels END,'removeLabels',CASE WHEN mode='replace' THEN ARRAY(SELECT x FROM unnest(e.labels)x WHERE x ~ '^[\x21\x23\x24\x26\x27\x2b-\x5b\x5e-\x7a\x7c-\x7e]{1,64}$' AND x NOT IN ('unverified','spam','guard-allowed') EXCEPT SELECT unnest(labels)) WHEN mode='remove' THEN labels ELSE ARRAY[]::text[] END); END IF;
  result:=inbox_mutate(w,b,e.message_id,op,data,false);
  IF result?'error' THEN RAISE EXCEPTION 'Protocol batch refused' USING ERRCODE='22023'; END IF;
  IF e.held_reason IS NULL AND e.thread_id IS NOT NULL AND NOT e.thread_id=ANY(threads) THEN threads:=threads||e.thread_id; END IF;
  IF result->>'uid' IS NOT NULL THEN pairs:=pairs||jsonb_build_array(jsonb_build_array(e.uid,result->'uid')); END IF;
 END LOOP;
 PERFORM inbox_refresh_thread(b,t) FROM unnest(threads) t;
 RETURN jsonb_build_object('pairs',pairs,'validity',validity);
END $$;

-- Folders: 1,000 per inbox (was 200) and paths 16 levels deep (was 8); the path itself stays at most 255 bytes.
CREATE OR REPLACE FUNCTION inbox_apply_folder_edit(wid text,bid text,op text,fid text,p text,sub boolean) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE f inbox_folders; made text; stamp bigint; item record; prefix text;
BEGIN
 IF NOT inbox_lock_visible(wid,bid) THEN RETURN '{"error":"NOT_FOUND"}'; END IF;
 IF op IN ('create','rename') AND (p IS NULL OR octet_length(p) NOT BETWEEN 1 AND 255 OR p ~ '[[:cntrl:]]|(^/|/$|//)' OR cardinality(string_to_array(p,'/'))>16 OR lower(p) IN ('inbox','sent','drafts','junk','archive','trash')) THEN RETURN '{"error":"INVALID_PATH"}'; END IF;
 IF op<>'create' THEN SELECT * INTO f FROM inbox_folders WHERE inbox_id=bid AND role=fid; IF NOT FOUND THEN RETURN '{"error":"NOT_FOUND"}'; END IF; END IF;
 IF op IN ('create','rename') AND EXISTS(SELECT FROM inbox_folders WHERE inbox_id=bid AND custom_path=p) THEN RETURN '{"error":"ALREADYEXISTS"}'; END IF;
 IF op='create' THEN
  IF (SELECT count(*) FROM inbox_folders WHERE inbox_id=bid)>=1000 THEN RETURN '{"error":"FOLDER_LIMIT"}'; END IF;
  made:='fld_'||replace(gen_random_uuid()::text,'-','');
  INSERT INTO inbox_folders(inbox_id,role,custom_path,subscribed,uid_validity) VALUES(bid,made,p,false,nextval('inbox_custom_validity')) RETURNING * INTO f;
 ELSIF op='subscribe' THEN UPDATE inbox_folders SET subscribed=sub WHERE inbox_id=bid AND role=fid RETURNING * INTO f;
 ELSIF f.custom_path IS NULL THEN RETURN '{"error":"PROTECTED_FOLDER"}';
 ELSIF op='rename' THEN
  prefix:=f.custom_path||'/'; IF starts_with(p,prefix) THEN RETURN '{"error":"INVALID_PATH"}'; END IF;
  IF EXISTS(SELECT FROM inbox_folders c WHERE c.inbox_id=bid AND starts_with(c.custom_path,prefix) AND (octet_length(p||substr(c.custom_path,length(f.custom_path)+1))>255 OR cardinality(string_to_array(p||substr(c.custom_path,length(f.custom_path)+1),'/'))>16 OR EXISTS(SELECT FROM inbox_folders d WHERE d.inbox_id=bid AND d.custom_path=p||substr(c.custom_path,length(f.custom_path)+1) AND NOT starts_with(d.custom_path,prefix)))) THEN RETURN '{"error":"INVALID_PATH"}'; END IF;
  UPDATE inbox_folders SET custom_path=p||substr(custom_path,length(f.custom_path)+1) WHERE inbox_id=bid AND (role=fid OR starts_with(custom_path,prefix));
 ELSIF op='delete' THEN
  FOR item IN SELECT * FROM inbox_entries WHERE inbox_id=bid AND role=fid ORDER BY uid LOOP
   -- Preserve the last membership in Trash, rather than orphaning it via FK cascade.
   PERFORM inbox_mutate(wid,bid,item.message_id,CASE WHEN EXISTS(SELECT FROM inbox_entries WHERE inbox_id=bid AND message_id=item.message_id AND (role,uid)<>(fid,item.uid)) THEN 'expunge' ELSE 'move' END,jsonb_build_object('source',fid,'uid',item.uid,'folder','trash'));
  END LOOP;
  DELETE FROM inbox_folders WHERE inbox_id=bid AND role=fid;
 ELSE RETURN '{"error":"INVALID_OP"}'; END IF;
 UPDATE inbox_state SET modseq=modseq+1,changes_floor=CASE WHEN op='delete' THEN modseq+1 ELSE changes_floor END WHERE inbox_id=bid RETURNING modseq INTO stamp;
 RETURN jsonb_build_object('id',f.role,'state',stamp::text);
END $$;
