SET LOCAL lock_timeout='2s';
-- Built-in domains (src/builtin-domain.ts): every Hosted workspace gets a subdomain of NIGHTMAIL_BUILTIN_DOMAIN
-- (nightmail.email), <label>.<parent>, for example acme-k7.nightmail.email, that sends and receives before the workspace
-- verifies a domain of its own.
--
-- builtin_domains: the one label each workspace is given, unique, never reissued (rows are never deleted; a revoked
-- one keeps its label). allocate_builtin_domain picks a free label for a base the API derives from the workspace's name.
-- builtin_parent: the latest check of the parent's SES identity (one row per parent).
--
-- The domain itself is an ordinary claim of the workspace, marked identity.builtin, bound to its own shared connection
-- in us-east-2, where the parent identity is. It sends with the workspace's own tenant under the parent identity, and
-- receives on its own name through the pool's catch-all receipt rule (the wildcard MX), so it needs no DNS of its own.
--
-- send_admission (353) gains the built-in rules, otherwise unchanged; reserve_regional_claim (355) no longer counts the
-- built-in domain toward the workspace's domain total, otherwise unchanged.
CREATE TABLE builtin_domains (
  workspace_id text PRIMARY KEY,
  label text NOT NULL UNIQUE CHECK (label ~ '^[a-z0-9](?:[a-z0-9-]{0,40}[a-z0-9])?$' AND position('--' IN label)=0),
  name text NOT NULL UNIQUE CHECK (starts_with(name,label||'.') AND name=lower(name)),
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz, revoked_reason text,
  CONSTRAINT builtin_domains_revoked CHECK ((revoked_at IS NULL)=(revoked_reason IS NULL))
);
CREATE TABLE builtin_parent (
  name text PRIMARY KEY, ok boolean NOT NULL, ses jsonb, problem text, checked_at timestamptz NOT NULL DEFAULT now()
);

-- One label for the workspace: its existing one, or base-<2 to 4 random characters> that no workspace has had. A
-- concurrent allocation of the same label or for the same workspace makes the insert do nothing, and the next try
-- (or the existing row) wins. `reserved` lists labels never given out.
CREATE FUNCTION allocate_builtin_domain(wid text,base text,parent text,reserved jsonb) RETURNS text LANGUAGE plpgsql VOLATILE AS $$
DECLARE got text; candidate text; n int;
BEGIN
  SELECT name INTO got FROM builtin_domains WHERE workspace_id=wid;
  IF got IS NOT NULL THEN RETURN got; END IF;
  FOR attempt IN 1..24 LOOP
    n := CASE WHEN attempt<=8 THEN 2 WHEN attempt<=16 THEN 3 ELSE 4 END;
    candidate := base||'-'||(SELECT string_agg(substr('abcdefghijklmnopqrstuvwxyz0123456789',1+floor(random()*36)::int,1),'') FROM generate_series(1,n));
    CONTINUE WHEN reserved ? candidate;
    INSERT INTO builtin_domains(workspace_id,label,name) VALUES(wid,candidate,candidate||'.'||parent) ON CONFLICT DO NOTHING RETURNING name INTO got;
    IF got IS NOT NULL THEN RETURN got; END IF;
    SELECT name INTO got FROM builtin_domains WHERE workspace_id=wid;
    IF got IS NOT NULL THEN RETURN got; END IF;
  END LOOP;
  RAISE EXCEPTION 'No free built-in label for %', base;
END $$;

-- The workspace's built-in domain as a claim, once it has a ready shared connection with a ready Ohio region: the claim
-- (bound to that connection, receiving on its own name from the start), its domain row and its receiving host. Taken
-- in a claim reservation's lock order. A claim already on this connection is returned as it is (fresh=false); one left
-- from another connection is replaced, and a receiving host left from it is taken back with its addresses and routes.
-- `sending` is 'verified' when SES is simulated and 'pending' otherwise: the domain.builtin job verifies it once the
-- parent identity is associated with the workspace's tenant.
CREATE FUNCTION create_builtin_claim(wid text,dom_id text,mdom_id text,sending text,facts jsonb,OUT domain_id text,OUT host_id text,OUT name text,OUT fresh boolean)
RETURNS SETOF record LANGUAGE plpgsql VOLATILE AS $$
DECLARE b builtin_domains%ROWTYPE; pc provider_connections%ROWTYPE; claim domain_claims%ROWTYPE;
BEGIN
  SELECT * INTO b FROM builtin_domains bd WHERE bd.workspace_id=wid AND bd.revoked_at IS NULL;
  IF NOT FOUND THEN RETURN; END IF;
  SELECT c.* INTO pc FROM ses_installation_settings s JOIN provider_connections c USING(workspace_id)
    WHERE s.workspace_id=wid AND c.kind='shared' AND c.state='ready' FOR NO KEY UPDATE OF s FOR SHARE OF c;
  IF NOT FOUND THEN RETURN; END IF;
  PERFORM FROM provider_connection_regions r WHERE r.connection_id=pc.id AND r.region='us-east-2' AND r.sending_state='ready' FOR SHARE;
  IF NOT FOUND THEN RETURN; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(substring(b.name FROM '[^.]+\.[^.]+$'),84912));
  SELECT dc.* INTO claim FROM domain_claims dc WHERE dc.workspace_id=wid AND dc.name=b.name FOR UPDATE;
  IF FOUND AND claim.connection_id=pc.id THEN
    RETURN QUERY SELECT d.id,m.id,b.name,false FROM operation_domains d LEFT JOIN mailbox_domains m ON m.workspace_id=d.workspace_id AND m.domain_id=d.id AND m.parent_id IS NULL
      WHERE d.workspace_id=wid AND d.name=b.name;
    RETURN;
  END IF;
  DELETE FROM operation_domains d WHERE d.workspace_id=wid AND d.name=b.name;
  DELETE FROM domain_claims dc WHERE dc.workspace_id=wid AND dc.name=b.name;
  INSERT INTO domain_claims(name,workspace_id,connection_id,claim_scope,sending_state,receiving_state,receiving_host,identity,receiving_proved_at,receiving_identity_at)
    VALUES(b.name,wid,pc.id,'exclusive',sending,'active',b.name,facts,now(),now());
  INSERT INTO operation_domains(id,name,workspace_id,region) VALUES(dom_id,b.name,wid,'us-east-2');
  INSERT INTO mailbox_domains AS m(id,workspace_id,domain_id,name,region,receiving_host,status,enabled_at) VALUES(mdom_id,wid,dom_id,b.name,'us-east-2',b.name,'active',now())
    ON CONFLICT ON CONSTRAINT mailbox_domains_name DO UPDATE SET domain_id=excluded.domain_id,parent_id=NULL,region=excluded.region,receiving_host=excluded.receiving_host,status='active',
      lost_since=NULL,last_error=NULL,issue=NULL,enabled_at=now(),updated_at=now();
  RETURN QUERY SELECT dom_id,m.id,b.name,true FROM mailbox_domains m WHERE m.workspace_id=wid AND m.name=b.name;
END $$;

CREATE OR REPLACE FUNCTION reserve_regional_claim(wid text,host text,requested_region text,new_id text,importing text DEFAULT NULL,placed boolean DEFAULT false)
RETURNS TABLE(connection jsonb,token uuid,id text,readiness jsonb,fresh boolean,error_code text)
LANGUAGE plpgsql VOLATILE AS $$
DECLARE pc provider_connections%ROWTYPE; r provider_connection_regions%ROWTYPE; claim domain_claims%ROWTYPE;
BEGIN
  SELECT c.* INTO pc FROM ses_installation_settings s JOIN provider_connections c USING(workspace_id)
    WHERE s.workspace_id=wid AND (c.state='ready' OR (c.id=importing AND c.kind='byo' AND c.state='provisioning'))
    FOR NO KEY UPDATE OF s FOR SHARE OF c;
  IF NOT FOUND OR (importing IS NOT NULL AND (pc.kind<>'byo' OR pc.id<>importing)) THEN RETURN NEXT; RETURN; END IF;
  IF pc.kind='shared' AND NOT placed AND requested_region IS NOT NULL AND requested_region<>pc.region THEN
    connection:=to_jsonb(pc);error_code:='POOL_PLACEMENT_MANAGED';RETURN NEXT; RETURN;
  END IF;
  -- An idempotent request with no override selects its existing binding first (even when
  -- disabled, in which case fail closed rather than falling through to the default).
  requested_region:=coalesce(requested_region,(SELECT b.region FROM domain_sending_bindings b WHERE b.workspace_id=wid AND b.name=host),CASE WHEN pc.kind='shared' THEN pc.region END);
  SELECT cr.* INTO r FROM provider_connection_regions cr WHERE cr.connection_id=pc.id AND (requested_region IS NULL OR cr.region=requested_region)
    AND (cr.sending_state='ready' OR (importing=pc.id AND cr.sending_state='provisioning'))
    ORDER BY cr.region=pc.region DESC,cr.region LIMIT 1 FOR SHARE;
  IF NOT FOUND THEN RETURN NEXT; RETURN; END IF;
  connection:=to_jsonb(pc)||jsonb_build_object('region',r.region,'legacy',r.legacy,'managed_tenant',r.managed_tenant,'tenant_state',r.tenant_state,'legacy_names',
    CASE WHEN pc.kind='byo' THEN r.legacy ELSE coalesce((SELECT p.legacy_names FROM provider_pool_regions p WHERE p.region=r.region),r.legacy) END);
  PERFORM pg_advisory_xact_lock(hashtextextended(substring(host FROM '[^.]+\.[^.]+$'),84912));
  SELECT dc.* INTO claim FROM domain_claims dc WHERE dc.workspace_id=wid AND dc.name=host FOR UPDATE;
  fresh:=NOT FOUND;
  IF importing IS NULL AND coalesce(claim.claim_scope,'exclusive')<>'account' AND exclusive_domain_overlap(wid,host) THEN RETURN NEXT; RETURN; END IF;
  IF fresh THEN
    IF (SELECT (pc.kind<>'byo' AND count(*)>=workspace_domain_limit(wid)) OR (importing IS NULL AND count(*) FILTER(WHERE NOT dc.ever_proven)>=10) FROM domain_claims dc WHERE dc.workspace_id=wid AND NOT coalesce(dc.identity ? 'builtin',false)) THEN
      error_code:='DOMAIN_LIMIT_REACHED'; RETURN NEXT; RETURN;
    END IF;
    INSERT INTO domain_claims(name,workspace_id,connection_id,claim_scope) VALUES(host,wid,pc.id,CASE WHEN importing IS NULL THEN 'exclusive' ELSE 'account' END) RETURNING * INTO claim;
  ELSIF importing IS NULL AND domain_claim_expired(claim) THEN error_code:='DOMAIN_CLAIM_EXPIRED'; RETURN NEXT; RETURN;
  ELSIF claim.connection_id IS NULL THEN
    fresh:=true;
    UPDATE domain_claims dc SET connection_id=pc.id,claim_scope=CASE WHEN importing IS NOT NULL AND dc.claim_scope<>'txt' THEN 'account' ELSE dc.claim_scope END
      WHERE dc.workspace_id=wid AND dc.name=host RETURNING * INTO claim;
  ELSIF claim.connection_id=pc.id THEN
    SELECT b.domain_id INTO id FROM domain_sending_bindings b WHERE b.workspace_id=wid AND b.name=host AND b.connection_id=pc.id AND b.region=r.region;
    IF NOT FOUND THEN error_code:='DOMAIN_REGION_CONFLICT'; END IF;
    token:=claim.token; RETURN NEXT; RETURN;
  ELSE RETURN NEXT; RETURN;
  END IF;
  token:=claim.token;
  INSERT INTO operation_domains AS d(id,name,workspace_id,region) VALUES(new_id,host,wid,r.region) RETURNING d.id INTO id;
  IF importing IS NULL THEN
    INSERT INTO jobs(id,workspace_id,type,payload,available_at) VALUES('domain.verify:'||claim.token,wid,'domain.verify',
      jsonb_build_object('domainId',id,'token',claim.token,'start',floor(extract(epoch FROM now())*1000)),now()+interval '5 seconds')
      ON CONFLICT ON CONSTRAINT jobs_pkey DO UPDATE SET payload=excluded.payload,available_at=excluded.available_at,status='pending',lease_until=NULL;
  END IF;
  RETURN NEXT;
END $$;

CREATE OR REPLACE FUNCTION send_admission(wid text, actor jsonb, req jsonb, assets jsonb DEFAULT '[]') RETURNS jsonb LANGUAGE plpgsql VOLATILE AS $$
DECLARE
  stage text := req->>'stage'; lim jsonb := req->'limits'; mails jsonb := coalesce(req->'mails','[]');
  sim boolean := (req->>'simulated')::boolean; mx boolean := (req->>'multiTenant')::boolean; regional boolean := (req->>'regional')::boolean;
  cost int := coalesce((req->>'cost')::int,0); marketing int := coalesce((req->>'marketing')::int,0);
  domains jsonb := coalesce(actor->'domains','[]'); claimed boolean := false; previous jsonb; d jsonb;
  -- Billing applies to Hosted sending, never to the platform's own workspace.
  billed boolean := mx AND wid IS DISTINCT FROM req->>'platformWorkspace';
  s record; h jsonb; b jsonb; quota numeric; projected int; cap int; conn jsonb; routes jsonb := '{}'; facts jsonb;
  locked jsonb := '[]'; resolved jsonb := '[]'; m jsonb; i int := -1; host text; reg text; r jsonb; c jsonb;
  obs jsonb; ses jsonb; needs_dmarc boolean; used bigint; incoming int; reserved boolean; hour_cap int; files jsonb;
  outstanding jsonb; capped boolean; scheduled boolean := stage='send' AND req ? 'scheduledAt'; at timestamptz;
  bpol jsonb := req->'builtin'; bd builtin_domains%ROWTYPE; bi int; bown text; bn int; bused record;
BEGIN
  IF jsonb_typeof(req->'claim')='object' THEN
    previous := idempotency_claim(wid, actor->>'id', req->'claim'->>'path', req->'claim'->>'key', req->'claim'->>'hash', req->'claim'->'receipt');
    IF previous IS NOT NULL THEN RETURN previous; END IF;
    claimed := true;
  END IF;
  <<decide>> BEGIN
    -- A scheduled single send: a UTC instant from a minute ago (a sender's clock) to the horizon. Checked after the claim, so
    -- an exact retry replays its receipt however late it comes.
    IF scheduled THEN
      at := (req->>'scheduledAt')::timestamptz;
      IF at < clock_timestamp()-make_interval(secs=>(lim->'schedule'->>'skewSeconds')::int) OR at > clock_timestamp()+make_interval(secs=>(lim->'schedule'->>'horizonSeconds')::int) THEN
        d := jsonb_build_object('code','INVALID_SCHEDULE'); EXIT decide;
      END IF;
    END IF;
    IF req->>'locks'='take' THEN
      IF req->'campaign' ? 'id' THEN
        SELECT revision,archived_at IS NOT NULL AS archived INTO s FROM sending_campaigns WHERE workspace_id=wid AND id=req->'campaign'->>'id' FOR UPDATE;
        IF NOT FOUND THEN d := jsonb_build_object('code','NOT_FOUND'); EXIT decide; END IF;
        IF s.archived THEN d := jsonb_build_object('code','CAMPAIGN_ARCHIVED'); EXIT decide; END IF;
        IF s.revision<>(req->'campaign'->>'revision')::int THEN d := jsonb_build_object('code','CAMPAIGN_LOCKED'); EXIT decide; END IF;
      END IF;
      INSERT INTO job_schedule(workspace_id) VALUES(wid) ON CONFLICT(workspace_id) DO UPDATE SET turn=job_schedule.turn WHERE false;
    END IF;

    IF stage='reserve' THEN
      -- Unreleased intents of every active or resumable campaign plus their rows still queued, computed by the caller.
      outstanding := req->'outstanding'; incoming := coalesce((req->>'incoming')::int,0);
      IF (outstanding->>'total')::bigint+incoming>(lim->>'campaignPendingWorkspace')::bigint OR (outstanding->>'key')::bigint+incoming>(lim->>'campaignPendingKey')::bigint THEN
        d := jsonb_build_object('code','CAMPAIGN_PENDING_LIMIT_EXCEEDED'); END IF;
      EXIT decide;
    END IF;

    IF req->>'locks'='none' THEN SELECT default_region,enabled_regions INTO s FROM ses_installation_settings WHERE workspace_id=wid;
    ELSE SELECT default_region,enabled_regions INTO s FROM ses_installation_settings WHERE workspace_id=wid FOR SHARE; END IF;

    IF stage='release' THEN
      IF mx THEN
        h := (SELECT allowance FROM hosted_allowance(wid,CASE WHEN sim THEN 0 ELSE 1 END,0,(req->'caps'->>'firstWeek')::int,NULL,NULL,(req->>'headroom')::numeric));
        IF jsonb_typeof(h)='object' AND billed THEN b := billing_gate(wid,0,sim); END IF;
        IF h->>'pauseReason' IS NOT NULL THEN d := jsonb_build_object('code','HOSTED_SENDING_PAUSED','reason',h->>'pauseReason'); EXIT decide; END IF;
        IF NOT sim AND coalesce((h->>'marketingHeld')::boolean,false) THEN d := jsonb_build_object('code','MARKETING_HELD','reason',h->>'marketingHoldReason'); EXIT decide; END IF;
      END IF;
      IF jsonb_typeof(mails->0->'binding')='object' AND NOT review_binding_ready(wid,mails->0->>'from',mails->0->>'region',mails->0->'binding',sim,req->'platform') THEN
        d := jsonb_build_object('code','SENDER_BINDING_CHANGED'); EXIT decide;
      END IF;
      EXIT decide;
    END IF;

    -- send, launch and prepare.
    IF s.default_region IS NULL THEN d := jsonb_build_object('code','REGION_SETTINGS_NOT_INITIALIZED'); EXIT decide; END IF;
    IF mx AND stage<>'prepare' THEN
      h := (SELECT allowance FROM hosted_allowance(wid,cost,marketing,(req->'caps'->>'firstWeek')::int,NULL,NULL,(req->>'headroom')::numeric));
    END IF;
    IF regional AND stage<>'prepare' THEN
      SELECT coalesce(jsonb_object_agg(k.host,to_jsonb(x)),'{}') INTO routes
        FROM (SELECT DISTINCT lower(e->>'host') AS host FROM jsonb_array_elements(mails) e) k CROSS JOIN LATERAL regional_sender(wid,k.host,sim,req->'platform') x;
    ELSIF mx AND stage<>'prepare' THEN
      EXECUTE format('SELECT to_jsonb(c) FROM %I c WHERE c.workspace_id=$1 AND c.region=$2', CASE WHEN sim THEN 'regional_simulated_connections' ELSE 'regional_sending_connections' END)
        INTO conn USING wid, coalesce(mails->0->>'region',s.default_region);
      SELECT coalesce(jsonb_object_agg(v.key,true),'{}') INTO routes FROM (
        SELECT DISTINCT lower(e->>'host')||':'||coalesce(e->>'region',s.default_region) AS key FROM jsonb_array_elements(mails) e
        WHERE EXISTS (SELECT FROM verified_sending_domains v WHERE v.workspace_id=wid AND v.region=coalesce(e->>'region',s.default_region)
          AND right('.'||lower(e->>'host'),length(v.name)+1)='.'||v.name)) v;
    END IF;
    -- A campaign being prepared keeps the binding it was reviewed with: checked, with the sender claim it locks, before
    -- any attachment is locked. One reviewed without a binding keeps its region (below).
    IF stage='prepare' AND jsonb_typeof(mails->0->'binding')='object'
        AND NOT review_binding_ready(wid,mails->0->>'from',mails->0->>'region',mails->0->'binding',sim,req->'platform') THEN
      d := jsonb_build_object('code','SENDER_BINDING_CHANGED'); EXIT decide;
    END IF;
    -- Built-in domains (src/builtin-domain.ts): mail from the workspace's own <label>.<parent> host is plain transactional
    -- mail sent now, to the recipients the configured scope allows (req->'builtin': scope, perDay, perMinute), and only
    -- while the workspace has no verified domain of its own. Its recipients are counted from sending_emails after the send
    -- locks, so a concurrent send has committed. A path that admits such mail without naming its recipients is refused.
    IF stage IN ('send','launch','prepare') THEN
      SELECT * INTO bd FROM builtin_domains WHERE workspace_id=wid;
      IF FOUND THEN
        bi := (SELECT min(o-1) FROM jsonb_array_elements(mails) WITH ORDINALITY e(v,o) WHERE lower(v->>'host')=bd.name OR right(lower(v->>'host'),length(bd.name)+1)='.'||bd.name);
      END IF;
      IF bi IS NOT NULL THEN
        IF bd.revoked_at IS NOT NULL THEN d := jsonb_build_object('code','BUILTIN_DOMAIN_REVOKED','item',bi,'host',bd.name); EXIT decide; END IF;
        IF jsonb_typeof(bpol) IS DISTINCT FROM 'object' THEN d := jsonb_build_object('code','BUILTIN_DOMAIN_UNAVAILABLE','item',bi,'host',bd.name); EXIT decide; END IF;
        i := (SELECT min(o-1) FROM jsonb_array_elements(mails) WITH ORDINALITY e(v,o) WHERE right(lower(v->>'host'),length(bd.name)+1)='.'||bd.name);
        IF i IS NOT NULL THEN d := jsonb_build_object('code','BUILTIN_DOMAIN_UNSUPPORTED','item',i,'field','from','host',bd.name); EXIT decide; END IF;
        SELECT dc.name INTO bown FROM domain_claims dc WHERE dc.workspace_id=wid AND dc.sending_state IN ('verified','lost') AND dc.name<>bd.name ORDER BY dc.name LIMIT 1;
        IF bown IS NOT NULL THEN d := jsonb_build_object('code','OWN_DOMAIN_VERIFIED','item',bi,'host',bown,'builtin',bd.name); EXIT decide; END IF;
        IF stage<>'send' THEN d := jsonb_build_object('code','BUILTIN_DOMAIN_UNSUPPORTED','item',bi,'field','campaign','host',bd.name); EXIT decide; END IF;
        IF scheduled THEN d := jsonb_build_object('code','BUILTIN_DOMAIN_UNSUPPORTED','item',bi,'field','scheduledAt','host',bd.name); EXIT decide; END IF;
        i := (SELECT min(o-1) FROM jsonb_array_elements(mails) WITH ORDINALITY e(v,o) WHERE lower(v->>'host')=bd.name AND v->>'kind' IS DISTINCT FROM 'transactional');
        IF i IS NOT NULL THEN d := jsonb_build_object('code','BUILTIN_DOMAIN_UNSUPPORTED','item',i,'field','kind','host',bd.name); EXIT decide; END IF;
        i := (SELECT min(o-1) FROM jsonb_array_elements(mails) WITH ORDINALITY e(v,o) WHERE lower(v->>'host')=bd.name AND jsonb_array_length(coalesce(v->'attachments','[]'))>0);
        IF i IS NOT NULL THEN d := jsonb_build_object('code','BUILTIN_DOMAIN_UNSUPPORTED','item',i,'field','attachments','host',bd.name); EXIT decide; END IF;
        i := (SELECT min(o-1) FROM jsonb_array_elements(mails) WITH ORDINALITY e(v,o) WHERE lower(v->>'host')=bd.name AND jsonb_typeof(v->'recipients') IS DISTINCT FROM 'array');
        IF i IS NOT NULL THEN d := jsonb_build_object('code','BUILTIN_DOMAIN_UNAVAILABLE','item',i,'host',bd.name); EXIT decide; END IF;
        IF bpol->>'scope'='members' THEN
          i := (SELECT min(o-1) FROM jsonb_array_elements(mails) WITH ORDINALITY e(v,o) WHERE lower(v->>'host')=bd.name
            AND EXISTS (SELECT FROM jsonb_array_elements_text(v->'recipients') x(email) WHERE NOT EXISTS (
              SELECT FROM workspace_members wm JOIN nightmail_users u ON u.id=wm.user_id WHERE wm.workspace_id=wid AND u.email_verified AND lower(u.email)=lower(x.email))));
          IF i IS NOT NULL THEN d := jsonb_build_object('code','BUILTIN_DOMAIN_RECIPIENT','item',i,'host',bd.name); EXIT decide; END IF;
        END IF;
        bn := (SELECT coalesce(sum(jsonb_array_length(v->'recipients')),0) FROM jsonb_array_elements(mails) v WHERE lower(v->>'host')=bd.name);
        SELECT coalesce(sum(x.n) FILTER (WHERE x.created_at>clock_timestamp()-interval '1 minute'),0) AS minute, coalesce(sum(x.n),0) AS day,
            min(x.created_at) FILTER (WHERE x.created_at>clock_timestamp()-interval '1 minute') AS minute_from, min(x.created_at) AS day_from INTO bused
          FROM (SELECT e.created_at,jsonb_array_length(e.to_addresses)+jsonb_array_length(e.cc_addresses)+jsonb_array_length(e.bcc_addresses) AS n
            FROM sending_emails e WHERE e.workspace_id=wid AND e.created_at>clock_timestamp()-interval '24 hours' AND lower(split_part(e.from_address,'@',2))=bd.name) x;
        IF bused.minute+bn>(bpol->>'perMinute')::int THEN
          d := jsonb_build_object('code','BUILTIN_DOMAIN_LIMIT','item',bi,'window','minute','cap',(bpol->>'perMinute')::int,'host',bd.name,
            'resetAt',coalesce(bused.minute_from+interval '1 minute',clock_timestamp()+interval '1 minute')); EXIT decide; END IF;
        IF bused.day+bn>(bpol->>'perDay')::int THEN
          d := jsonb_build_object('code','BUILTIN_DOMAIN_LIMIT','item',bi,'window','day','cap',(bpol->>'perDay')::int,'host',bd.name,
            'resetAt',coalesce(bused.day_from+interval '24 hours',clock_timestamp()+interval '24 hours')); EXIT decide; END IF;
      END IF;
      i := -1;
    END IF;
    -- Attachments last: lock the visible rows the request names, in id order.
    IF jsonb_array_length(assets)>0 THEN
      SELECT coalesce(jsonb_agg(a ORDER BY a.id),'[]') INTO locked FROM (
        SELECT id,size,content_id AS "contentId",content_type AS "contentType" FROM sending_attachments
        WHERE workspace_id=wid AND id IN (SELECT jsonb_array_elements_text(assets)) ORDER BY id FOR UPDATE) a;
    END IF;
    IF jsonb_typeof(h)='object' AND billed AND (req->>'billable')::int>0 THEN b := billing_gate(wid,(req->>'billable')::int,sim); END IF;
    IF (req->>'requireDmarc')::boolean THEN
      SELECT jsonb_object_agg(dc.name,dc.identity-'mx'-'note') INTO facts FROM domain_claims dc
        WHERE dc.workspace_id=wid AND dc.sending_state IN ('verified','lost') AND dc.name IN (SELECT lower(e->>'host') FROM jsonb_array_elements(mails) e);
    END IF;

    IF stage='send' THEN
      -- Billing first: an enforced empty balance refuses whatever else would.
      IF (b->>'enforced')::boolean AND NOT (b->>'ok')::boolean THEN d := jsonb_build_object('code','BALANCE_EXHAUSTED'); EXIT decide; END IF;
      IF jsonb_typeof(h)='object' THEN
        IF h->>'pauseReason' IS NOT NULL THEN d := jsonb_build_object('code','HOSTED_SENDING_PAUSED','reason',h->>'pauseReason'); EXIT decide; END IF;
        IF marketing>0 AND coalesce((h->>'marketingHeld')::boolean,false) THEN d := jsonb_build_object('code','MARKETING_HELD','reason',h->>'marketingHoldReason'); EXIT decide; END IF;
        IF h->>'cap' IS NOT NULL THEN
          used := (h->>'used')::bigint;
          reserved := marketing>0 AND marketing+used>(h->>'marketingCap')::bigint;
          hour_cap := (h->>'marketingHourCap')::int;
          IF reserved AND hour_cap IS NOT NULL AND coalesce((h->>'marketingHourUsed')::int,0)+marketing>hour_cap AND cost+used<=(h->>'cap')::bigint THEN
            d := jsonb_build_object('code','SEND_LIMIT_REACHED','window','hour','allowance',h,'incoming',cost,'marketing',marketing); EXIT decide;
          END IF;
          IF cost>0 AND (cost+used>(h->>'cap')::bigint OR reserved) THEN
            d := jsonb_build_object('code','SEND_LIMIT_REACHED','window','day','reserved',reserved,'allowance',h,'incoming',cost,'marketing',marketing); EXIT decide;
          END IF;
        END IF;
      END IF;
      IF scheduled THEN
        -- Scheduled mail is charged nothing now (no cost, billable or marketing reaches this call): the limits, the balance
        -- and the queue are checked at its time, when it is admitted again as a send. Now only how many may wait.
        IF (SELECT count(*) FROM sending_emails WHERE workspace_id=wid AND status='scheduled')+jsonb_array_length(mails)>(lim->'schedule'->>'workspace')::int THEN
          d := jsonb_build_object('code','SCHEDULED_EMAIL_LIMIT_EXCEEDED','cap',(lim->'schedule'->>'workspace')::int); EXIT decide;
        END IF;
      ELSE
        -- Outstanding direct mail, a day of what the workspace can send within the floor and the ceiling: the override; on the
        -- shared pool the ceiling when exempt, a day of its pace in good standing (no daily limit, past the growth pace), else
        -- the floor; otherwise a day of the account's own SES quota.
        SELECT p.projected INTO projected FROM direct_pending_load(wid,jsonb_array_length(mails),
          jsonb_array_length(jsonb_path_query_array(mails,'$[*] ? (@.kind == "marketing")'))) p;
        IF jsonb_typeof(h)='object' THEN
          cap := coalesce((h->>'pendingCapOverride')::int,CASE WHEN (h->>'exemptHostedQuotas')::boolean THEN (lim->>'pendingCeiling')::int
            WHEN h->>'cap' IS NULL AND NOT EXISTS (SELECT FROM hosted_growth(wid)) THEN least((lim->>'pendingCeiling')::int,greatest((lim->>'pendingFloor')::int,hosted_pool_pace(wid)::bigint*1440))::int
            ELSE (lim->>'pendingFloor')::int END);
        ELSE
          quota := CASE WHEN mx THEN (SELECT max(l.max_24_hour_send) FROM regional_workspace_limits l WHERE l.workspace_id=wid
              AND EXISTS (SELECT FROM provider_connections pc WHERE pc.workspace_id=wid AND pc.kind='byo'))
            ELSE (SELECT max(max_24_hour_send) FROM sending_region_limits WHERE workspace_id=wid) END;
          cap := least((lim->>'pendingCeiling')::int,greatest((lim->>'pendingFloor')::int,floor(coalesce(quota,0))::int));
        END IF;
        IF projected>cap THEN d := jsonb_build_object('code','PENDING_EMAIL_LIMIT_EXCEEDED','cap',cap); EXIT decide; END IF;
      END IF;
    END IF;

    FOR m IN SELECT * FROM jsonb_array_elements(mails) LOOP
      i := i+1; host := lower(m->>'host');
      -- A built-in sender's From is signed for its parent domain, and its mail is never bulk.
      needs_dmarc := NOT coalesce(host=bd.name,false) AND (m->>'kind'='marketing' OR (stage='send' AND cost>0 AND coalesce((h->>'used')::bigint,0)+cost>=(lim->>'bulkVolume')::int));
      IF stage='prepare' AND jsonb_typeof(m->'binding')='object' THEN
        reg := m->>'region'; c := NULL; -- Its reviewed binding was checked above.
      ELSIF regional AND stage<>'prepare' THEN
        IF domains<>'[]' AND NOT EXISTS (SELECT FROM jsonb_array_elements_text(domains) x WHERE host=lower(x) OR right(host,length(x)+1)='.'||lower(x)) THEN
          d := jsonb_build_object('code','SENDER_DOMAIN_FORBIDDEN','item',i); EXIT decide; END IF;
        r := routes->host; c := r->'connection'; reg := r->>'region';
        IF (r->>'platform_refused')::boolean THEN d := jsonb_build_object('code','PLATFORM_SENDER_REFUSED','item',i); EXIT decide; END IF;
        IF NOT coalesce((r->>'verified')::boolean,false) THEN d := jsonb_build_object('code','SENDER_DOMAIN_NOT_VERIFIED','item',i); EXIT decide; END IF;
        IF m->>'region' IS NOT NULL AND m->>'region'<>reg THEN d := jsonb_build_object('code','SENDER_REGION_MISMATCH','item',i); EXIT decide; END IF;
        IF jsonb_typeof(c)<>'object' THEN d := jsonb_build_object('code','CONNECTION_REQUIRED','item',i,'regional',true); EXIT decide; END IF;
        IF nullif(c->>'pool_tenant_name','') IS NOT NULL AND c->>'pool_tier'='trusted' AND NOT (req->>'trustedPool')::boolean THEN
          d := jsonb_build_object('code','TRUSTED_POOL_DISABLED','item',i); EXIT decide; END IF;
      ELSE
        reg := coalesce(m->>'region',s.default_region);
        IF NOT s.enabled_regions ? reg THEN d := jsonb_build_object('code','REGION_NOT_CONFIGURED','item',i); EXIT decide; END IF;
        IF stage<>'prepare' AND domains<>'[]' AND NOT EXISTS (SELECT FROM jsonb_array_elements_text(domains) x WHERE host=lower(x) OR right(host,length(x)+1)='.'||lower(x)) THEN
          d := jsonb_build_object('code','SENDER_DOMAIN_FORBIDDEN','item',i); EXIT decide; END IF;
        IF mx AND stage<>'prepare' THEN
          IF NOT routes ? (host||':'||reg) THEN d := jsonb_build_object('code','SENDER_DOMAIN_NOT_VERIFIED','item',i); EXIT decide; END IF;
          c := conn;
          IF c->>'region' IS DISTINCT FROM reg THEN d := jsonb_build_object('code','CONNECTION_REQUIRED','item',i,'regional',false); EXIT decide; END IF;
        ELSIF NOT mx AND jsonb_typeof(req->'readiness')='object' AND NOT EXISTS (SELECT FROM ses_region_discovery x WHERE x.workspace_id=wid AND x.region=reg
            AND x.credentials_fingerprint=req->'readiness'->>'fingerprint' AND x.public_url=req->'readiness'->>'target'
            AND x.report->'provisioned'='true' AND x.report#>'{account,sendingEnabled}'='true'
            AND x.report#>'{account,id}'=coalesce(to_jsonb(x.trusted_account_id),'null') AND x.report#>'{resources,topic,arn}'=coalesce(to_jsonb(x.trusted_topic_arn),'null')
            AND x.report->'resources'->(m->>'kind')->'sendingEnabled'='true') THEN
          d := jsonb_build_object('code','SES_SETUP_REQUIRED','item',i); EXIT decide;
        END IF;
      END IF;
      IF mx AND stage<>'prepare' THEN
        IF c->>'pause_reason' IS NOT NULL THEN d := jsonb_build_object('code','HOSTED_SENDING_PAUSED','item',i,'reason',c->>'pause_reason'); EXIT decide; END IF;
        IF NOT sim AND c->>'kind'='shared' AND c->>'tenant_state' IS DISTINCT FROM 'ready' THEN
          d := jsonb_build_object('code','TENANT_NOT_READY','item',i,'failed',c->>'tenant_state'='failed'); EXIT decide; END IF;
        IF (req->>'requireDmarc')::boolean AND c->>'kind'='shared' AND needs_dmarc THEN
          obs := facts->host->'dmarc'; ses := facts->host->'ses';
          IF NOT (coalesce(obs->>'status' IN ('none','quarantine','reject'),false)
              AND coalesce((obs->>'checkedAt')::numeric>=extract(epoch FROM clock_timestamp()-make_interval(hours=>(lim->>'dmarcMaxAgeHours')::int))*1000,false)
              AND (coalesce(ses#>'{DkimAttributes,SigningEnabled}'='true' AND ses#>>'{DkimAttributes,Status}'='SUCCESS',false)
                OR coalesce(nullif(obs->>'alignedMailFrom','')=lower(rtrim(ses#>>'{MailFromAttributes,MailFromDomain}','.')) AND ses#>>'{MailFromAttributes,MailFromDomainStatus}'='SUCCESS',false))) THEN
            d := jsonb_build_object('code','BULK_DMARC_REQUIRED','item',i,'host',host); EXIT decide;
          END IF;
        END IF;
      END IF;
      IF stage='launch' AND c->>'kind'='shared' THEN
        IF (req->>'autoPause')='false' THEN d := jsonb_build_object('code','HOSTED_AUTO_PAUSE_REQUIRED'); EXIT decide; END IF;
        IF coalesce((h->>'marketingHeld')::boolean,false) THEN d := jsonb_build_object('code','MARKETING_HELD','reason',h->>'marketingHoldReason'); EXIT decide; END IF;
        IF (b->>'enforced')::boolean AND NOT (b->>'ok')::boolean THEN d := jsonb_build_object('code','BALANCE_EXHAUSTED'); EXIT decide; END IF;
      END IF;
      -- The message's attachments: none named twice, then, as stored, all present and within the size and MIME limits SES accepts.
      IF (m->>'duplicate')::boolean THEN d := jsonb_build_object('code','DUPLICATE_ATTACHMENT','item',i); EXIT decide; END IF;
      SELECT coalesce(jsonb_agg(a),'[]') INTO files FROM jsonb_array_elements(locked) a WHERE m->'attachments' ? (a->>'id');
      IF jsonb_array_length(files)<>jsonb_array_length(m->'attachments') THEN d := jsonb_build_object('code','ATTACHMENT_NOT_FOUND','item',i); EXIT decide; END IF;
      IF (SELECT coalesce(sum((a->>'size')::bigint),0) FROM jsonb_array_elements(files) a)>(lim->>'attachmentBytes')::bigint THEN
        d := jsonb_build_object('code','ATTACHMENT_LIMIT_EXCEEDED','item',i); EXIT decide; END IF;
      IF (SELECT count(a->>'contentId')<>count(DISTINCT a->>'contentId') FROM jsonb_array_elements(files) a) THEN
        d := jsonb_build_object('code','DUPLICATE_CONTENT_ID','item',i); EXIT decide; END IF;
      IF EXISTS (SELECT FROM jsonb_array_elements(files) a WHERE length(a->>'contentType')>(lim->>'mimeFieldChars')::int OR a->>'contentType' ~ '[^ -~]'
          OR length(a->>'contentId')>(lim->>'mimeFieldChars')::int) THEN
        d := jsonb_build_object('code','ATTACHMENT_METADATA_INVALID','item',i); EXIT decide; END IF;
      IF stage='send' AND ceil((m->>'bodyBytes')::numeric*(lim->'mime'->>'bodyFactor')::numeric)
          +(SELECT coalesce(sum(ceil((a->>'size')::numeric/3)*4*(lim->'mime'->>'lineFactor')::numeric+(lim->'mime'->>'perAttachment')::numeric),0) FROM jsonb_array_elements(files) a)
          +(lim->'mime'->>'envelope')::numeric>(lim->>'encodedBytes')::numeric THEN
        d := jsonb_build_object('code','ENCODED_MESSAGE_TOO_LARGE','item',i); EXIT decide;
      END IF;
      resolved := resolved||jsonb_build_object('region',reg,'binding',CASE WHEN regional AND stage<>'prepare' THEN r->'binding' END,'connection',c);
    END LOOP;
    -- Content TypeScript found invalid (headers, duplicates, URLs measured locally): reported after every policy rule.
    i := (SELECT min(o-1) FROM jsonb_array_elements(mails) WITH ORDINALITY e(v,o) WHERE (v->>'invalid')::boolean);
    IF i IS NOT NULL THEN d := jsonb_build_object('code','INVALID_CONTENT','item',i); EXIT decide; END IF;
    -- Content the Hosted screen would refuse at dispatch: only mail on a shared connection is screened.
    i := (SELECT min(o-1) FROM jsonb_array_elements(mails) WITH ORDINALITY e(v,o) WHERE (v->>'oversize')::boolean AND resolved->(o::int-1)->'connection'->>'kind'='shared');
    IF i IS NOT NULL THEN d := jsonb_build_object('code','CONTENT_TOO_LARGE_TO_SCREEN','item',i); EXIT decide; END IF;
  END decide;
  IF d IS NOT NULL THEN
    -- A refusal frees the key it claimed, so the same request can be retried.
    IF claimed THEN DELETE FROM sending_idempotency WHERE workspace_id=wid AND actor_key_id=actor->>'id' AND path=req->'claim'->>'path' AND request_key=req->'claim'->>'key'; END IF;
    RETURN d || jsonb_build_object('allowed',false,'billing',b);
  END IF;
  IF stage='release' AND jsonb_typeof(h)='object' THEN
    capped := NOT sim AND h->>'marketingCap' IS NOT NULL;
    RETURN jsonb_build_object('allowed',true,'hostedLeft',CASE WHEN capped THEN greatest(0,(h->>'marketingCap')::bigint-(h->>'used')::bigint) END,'nextChangeAt',h->>'nextChangeAt',
      'billing',CASE WHEN b->>'mode'='prepaid' AND b->>'enforcement'<>'off' THEN jsonb_build_object('enforced',(b->>'enforced')::boolean,'freeSentLeft',(b->>'freeSentLeft')::int,'availableUc',b->>'availableUc',
        'affordable',CASE WHEN (b->>'availableUc')::numeric<0 THEN 0 ELSE (b->>'freeSentLeft')::bigint+floor((b->>'availableUc')::numeric/(req->>'emailUc')::numeric)::bigint END) END);
  END IF;
  RETURN jsonb_build_object('allowed',true,'mails',resolved,'billing',b,'assets',locked,'shared',jsonb_typeof(h)='object');
END $$;
