-- Marketing sent through the API ramps with the workspace's campaigns (src/standing-model.ts RAMP; docs/sending-limits.md).
-- A Hosted workspace's `kind: "marketing"` mail from POST /v1/emails/send and /v1/emails/batch (and a scheduled one at its
-- time) takes at most what its ramp step's hourly ceiling has left, shared with its ramping campaigns, so a workspace on
-- the ramp, exempt or first-party included, can't send a whole list at full rate around its campaigns. Transactional mail
-- is never asked.
--
-- 1. hosted_usage_hourly.api_marketing: the hour's marketing recipients that are not a campaign's, charged by the same
--    statement triggers as `marketing` (hosted_charge_batch and hosted_adjust_usage_stmt, unchanged from 432 otherwise),
--    so a send is charged in the statement that inserts it and uncharged when it is suppressed or canceled.
-- 2. ramp_clean_hour: the workspace's largest clean, mature marketing hour of the last 30 days, where it starts on the ramp
--    (src/sending.ts rampHistory now calls it).
-- 3. ramp_refusal: RAMP_PAUSED while a campaign of the workspace is quarantined (stopped by the automatic pause, the list
--    probe or the ramp's check, not resumed or canceled); else the workspace's step (the furthest a ramping campaign of it
--    is on, else where its history starts it) and the hour's room: the ceiling less this clock hour's api_marketing and
--    what its ramping campaigns released in their current hours. Over it: RAMP_LIMIT_REACHED, with how many fit now and
--    when more room opens. A send scheduled for later must fit a whole hour of the step and, with the marketing already
--    scheduled within 24 hours either side of its time, a day of it (src/sending.ts holds it at its time).
-- 4. send_admission (495) asks ramp_refusal for a live send on the shared pool that names its marketing recipients
--    (req->'ramp'), after the Hosted limits; otherwise unchanged. A refusal frees the idempotency claim as every refusal does.
--
-- Locks: the column is metadata only (a constant default), added under the same lock_timeout retry as 430, so it never
-- queues ACCESS EXCLUSIVE behind a sending transaction. CREATE OR REPLACE FUNCTION takes no lock a send waits on.
DO $$
BEGIN
  FOR attempt IN 1..60 LOOP
    BEGIN
      SET LOCAL lock_timeout = '2s';
      ALTER TABLE hosted_usage_hourly ADD COLUMN IF NOT EXISTS api_marketing bigint NOT NULL DEFAULT 0;
      RETURN;
    EXCEPTION WHEN lock_not_available THEN
      PERFORM pg_sleep(1);
    END;
  END LOOP;
  RAISE EXCEPTION 'hosted_usage_hourly was busy for 3 minutes. Nothing was changed: run the migration again.' USING ERRCODE = 'lock_not_available';
END $$;

CREATE OR REPLACE FUNCTION hosted_charge_batch() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  u_wids text[];
  u_hours timestamptz[];
  u_rec bigint[];
  u_mkt bigint[];
  u_api bigint[];
BEGIN
  WITH agg AS (
    SELECT n.workspace_id, date_trunc('hour', n.created_at, 'UTC') AS hour,
      sum(jsonb_array_length(n.to_addresses || n.cc_addresses || n.bcc_addresses))::bigint AS rec,
      coalesce(sum(jsonb_array_length(n.to_addresses || n.cc_addresses || n.bcc_addresses))
        FILTER (WHERE n.snapshot->>'kind' = 'marketing' OR n.campaign_id IS NOT NULL OR n.snapshot ? 'bulk'), 0)::bigint AS mkt,
      coalesce(sum(jsonb_array_length(n.to_addresses || n.cc_addresses || n.bcc_addresses))
        FILTER (WHERE n.snapshot->>'kind' = 'marketing' AND n.campaign_id IS NULL), 0)::bigint AS api
    FROM new_mail n
    LEFT JOIN provider_connections pc USING (workspace_id)
    WHERE NOT n.simulated AND hosted_charged(n.status, n.provider_id)
      AND ((n.feedback_topic_arn IS NULL AND pc.kind = 'shared') OR n.feedback_topic_arn IN (SELECT feedback_topic_arn FROM provider_pool_regions))
    GROUP BY 1, 2
  )
  SELECT array_agg(workspace_id ORDER BY workspace_id, hour),
         array_agg(hour ORDER BY workspace_id, hour),
         array_agg(rec ORDER BY workspace_id, hour),
         array_agg(mkt ORDER BY workspace_id, hour),
         array_agg(api ORDER BY workspace_id, hour)
  INTO u_wids, u_hours, u_rec, u_mkt, u_api
  FROM agg;

  IF u_wids IS NULL THEN RETURN NULL; END IF;

  PERFORM pg_advisory_xact_lock(275820, h)
  FROM (SELECT DISTINCT hashtext(wid) AS h FROM unnest(u_wids) AS wid ORDER BY 1) w;

  INSERT INTO hosted_usage_hourly AS u(workspace_id, hour, recipients, marketing, api_marketing)
  SELECT wid, hr, rec, mkt, api
  FROM unnest(u_wids, u_hours, u_rec, u_mkt, u_api) AS d(wid, hr, rec, mkt, api)
  ORDER BY wid, hr
  ON CONFLICT (workspace_id, hour) DO UPDATE
    SET recipients = u.recipients + excluded.recipients,
        marketing = u.marketing + excluded.marketing,
        api_marketing = u.api_marketing + excluded.api_marketing;
  RETURN NULL;
END $$;

CREATE OR REPLACE FUNCTION hosted_adjust_usage_stmt() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  u_wids text[];
  u_hours timestamptz[];
  u_rec bigint[];
  u_mkt bigint[];
  u_api bigint[];
BEGIN
  WITH changed AS (
    SELECT n.workspace_id, n.id, o.created_at AS old_at, n.created_at AS new_at,
      hosted_charged(o.status, o.provider_id, o.error_code)::int AS old_ch,
      hosted_charged(n.status, n.provider_id, n.error_code)::int AS new_ch,
      CASE WHEN n.charge_simulator
        THEN jsonb_array_length(n.to_addresses || n.cc_addresses || n.bcc_addresses)
        ELSE hosted_real_cost(n.to_addresses || n.cc_addresses || n.bcc_addresses) END AS cost,
      coalesce(n.snapshot->>'kind' = 'marketing' OR n.campaign_id IS NOT NULL OR n.snapshot ? 'bulk', false)::int AS mk,
      coalesce(n.snapshot->>'kind' = 'marketing' AND n.campaign_id IS NULL, false)::int AS api
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
    SELECT workspace_id, date_trunc('hour', old_at, 'UTC') AS hour, (-cost * old_ch)::bigint AS delta, (-cost * old_ch * mk)::bigint AS mdelta, (-cost * old_ch * api)::bigint AS adelta FROM changed
    UNION ALL
    SELECT workspace_id, date_trunc('hour', new_at, 'UTC') AS hour, (cost * new_ch)::bigint AS delta, (cost * new_ch * mk)::bigint AS mdelta, (cost * new_ch * api)::bigint AS adelta FROM changed
  ),
  agg AS (
    SELECT workspace_id, hour, sum(delta) AS rec, sum(mdelta) AS mkt, sum(adelta) AS api
    FROM legs
    WHERE hour >= date_trunc('hour', now(), 'UTC') - interval '23 hours'
    GROUP BY 1, 2
    HAVING sum(delta) <> 0 OR sum(mdelta) <> 0
  )
  SELECT array_agg(workspace_id ORDER BY workspace_id, hour),
         array_agg(hour ORDER BY workspace_id, hour),
         array_agg(rec ORDER BY workspace_id, hour),
         array_agg(mkt ORDER BY workspace_id, hour),
         array_agg(api ORDER BY workspace_id, hour)
  INTO u_wids, u_hours, u_rec, u_mkt, u_api
  FROM agg;

  IF u_wids IS NULL THEN RETURN NULL; END IF;

  PERFORM pg_advisory_xact_lock(275820, h)
  FROM (SELECT DISTINCT hashtext(wid) AS h FROM unnest(u_wids) AS wid ORDER BY 1) w;

  INSERT INTO hosted_usage_hourly AS u(workspace_id, hour, recipients, marketing, api_marketing)
  SELECT wid, hr, rec, mkt, api
  FROM unnest(u_wids, u_hours, u_rec, u_mkt, u_api) AS d(wid, hr, rec, mkt, api)
  ORDER BY wid, hr
  ON CONFLICT (workspace_id, hour) DO UPDATE
    SET recipients = u.recipients + excluded.recipients,
        marketing = u.marketing + excluded.marketing,
        api_marketing = u.api_marketing + excluded.api_marketing;
  RETURN NULL;
END $$;

-- Within the ramp's lines: bounces at most bounceRate of accepted, and complaints under `complaints` or at most complaintRate.
CREATE FUNCTION ramp_clean(accepted float8,bounced float8,complained float8,history jsonb) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT bounced<=accepted*(history->>'bounceRate')::float8 AND (complained<(history->>'complaints')::int OR complained<=accepted*(history->>'complaintRate')::float8)
$$;

-- The workspace's largest clean, mature hour of real marketing mail in the last `days` days, as SES accepted it
-- (sending_metrics_hourly, by the hour the mail was released; hours holding simulated mail are left out). Mature: `resolved`
-- of it delivered or bounced. Clean: within the lines (ramp_clean), and so is the whole window, else nothing counts. The
-- hour still running never counts. `history`: src/admission.ts RAMP_POLICY.history.
CREATE FUNCTION ramp_clean_hour(wid text,history jsonb) RETURNS int LANGUAGE sql STABLE AS $$
  WITH hours AS (
    SELECT hour,sum(accepted)::float8 AS a,sum(delivered)::float8 AS d,sum(bounced)::float8 AS b,sum(complained)::float8 AS c FROM sending_metrics_hourly
    WHERE workspace_id=wid AND kind='marketing' AND hour>=now()-make_interval(days=>(history->>'days')::int) AND hour<date_trunc('hour',now(),'UTC')
    GROUP BY hour HAVING sum(simulated)=0 AND sum(accepted)>0
  ), total AS (SELECT coalesce(sum(a),0) AS a,coalesce(sum(b),0) AS b,coalesce(sum(c),0) AS c FROM hours)
  SELECT CASE WHEN ramp_clean(t.a,t.b,t.c,history)
    THEN coalesce((SELECT max(a) FROM hours WHERE d+b>=a*(history->>'resolved')::float8 AND ramp_clean(a,b,c,history)),0) ELSE 0 END::int FROM total t
$$;

-- Whether `ramp`->>'recipients' more marketing recipients may go now, on a Hosted live workspace: NULL when they may,
-- else the refusal. `ramp`: src/admission.ts RAMP_POLICY and the request's recipients (`scheduled` and `at` for a send
-- scheduled for later).
-- 1. RAMP_PAUSED: a campaign of the workspace that the automatic pause, the list probe or the ramp's check stopped
--    (`ramp`->'paused' codes) and that its owner hasn't resumed or canceled pauses the workspace's marketing.
-- 2. The step: the furthest a ramping campaign of the workspace is on (src/sending.ts releaseStep places and moves them),
--    else where its clean history starts it (src/standing-model.ts rampStart). Past the last step: NULL.
-- 3. RAMP_LIMIT_REACHED. Sent now, the recipients fit in what the hour has left: this clock hour's API marketing
--    (hosted_usage_hourly.api_marketing) and what its ramping campaigns released in their current hours, as releaseStep
--    counts them. Scheduled for later, they fit a whole hour of the step, and with the marketing already scheduled within
--    24 hours either side of their time they fit what the step sends in 24 hours (at their time they are held until their
--    hour has room). More room opens at the first moment what the hour holds frees enough for more than fits now: the
--    next clock hour for the API's part, a campaign's hour's end for its part.
CREATE FUNCTION ramp_refusal(wid text,ramp jsonb) RETURNS jsonb LANGUAGE plpgsql STABLE AS $$
DECLARE
  n_steps int := jsonb_array_length(ramp->'steps'); asked bigint := (ramp->>'recipients')::bigint; later boolean := coalesce((ramp->>'scheduled')::boolean,false);
  this_hour timestamptz := date_trunc('hour',now(),'UTC'); r_step int; best int; ceiling_now bigint; api_used bigint; held bigint; room bigint; opens timestamptz;
  paused_id text; paused_code text; due_at timestamptz; backlog bigint; budget bigint;
BEGIN
  SELECT id,pause_reason->>'code' INTO paused_id,paused_code FROM sending_campaigns WHERE workspace_id=wid AND state='paused'
    AND pause_reason->>'code' IN (SELECT jsonb_array_elements_text(ramp->'paused')) ORDER BY paused_at DESC,id LIMIT 1;
  IF paused_id IS NOT NULL THEN RETURN jsonb_build_object('code','RAMP_PAUSED','campaignId',paused_id,'pauseCode',paused_code); END IF;
  SELECT max(ramp_step) INTO r_step FROM sending_campaigns WHERE workspace_id=wid AND state='sending' AND NOT simulated AND ramp_step<n_steps;
  IF r_step IS NULL THEN
    best := ramp_clean_hour(wid,ramp->'history');
    r_step := (SELECT count(*) FROM jsonb_array_elements_text(ramp->'steps') s(v) WHERE v::numeric*(ramp->>'advance')::numeric<=best);
  END IF;
  IF r_step>=n_steps THEN RETURN NULL; END IF;
  ceiling_now := (ramp->'steps'->>r_step)::bigint;
  api_used := coalesce((SELECT api_marketing FROM hosted_usage_hourly WHERE workspace_id=wid AND hour=this_hour),0);
  held := api_used+(SELECT coalesce(sum(greatest(expanded-ramp_from,0)),0) FROM sending_campaigns WHERE workspace_id=wid AND state='sending' AND NOT simulated
    AND ramp_step<n_steps AND ramp_window_started_at>now()-interval '1 hour');
  IF later THEN
    -- From sending_emails_scheduled_marketing (migration 502) alone. Marketing goes to exactly one recipient (src/sending.ts
    -- SendInput), so its rows are its recipients.
    due_at := (ramp->>'at')::timestamptz; budget := 24*ceiling_now;
    backlog := (SELECT count(*) FROM sending_emails WHERE workspace_id=wid AND status='scheduled' AND campaign_id IS NULL AND (snapshot->>'kind')='marketing'
      AND scheduled_at>due_at-interval '24 hours' AND scheduled_at<due_at+interval '24 hours');
    IF asked<=ceiling_now AND backlog+asked<=budget THEN RETURN NULL; END IF;
  ELSIF held+asked<=ceiling_now THEN RETURN NULL;
  END IF;
  room := greatest(0,ceiling_now-held);
  SELECT min(f.at) INTO opens FROM (SELECT x.at,sum(x.n) OVER (ORDER BY x.at) AS freed FROM (
      SELECT this_hour+interval '1 hour' AS at,api_used AS n WHERE api_used>0
      UNION ALL SELECT ramp_window_started_at+interval '1 hour',expanded-ramp_from FROM sending_campaigns WHERE workspace_id=wid AND state='sending' AND NOT simulated
        AND ramp_step<n_steps AND ramp_window_started_at>now()-interval '1 hour' AND expanded>ramp_from) x) f
    WHERE ceiling_now-(held-f.freed)>room;
  opens := coalesce(opens,this_hour+interval '1 hour');
  RETURN jsonb_build_object('code','RAMP_LIMIT_REACHED','scheduled',later,'step',r_step+1,'steps',n_steps,'cap',ceiling_now,'used',held,'fits',room,'marketing',asked,
    'backlog',backlog,'budget',budget,'resetAt',opens,'retryAfter',greatest(1,ceil(extract(epoch FROM opens-now())))::int);
END $$;

-- Unchanged from 495 except the ramp's check (ramp_refusal) after the Hosted limits.
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
      -- The ramp (src/standing-model.ts RAMP): marketing sent now on the shared pool, live, fits in what the workspace's ramp
      -- step has left this hour, shared with its ramping campaigns (ramp_refusal). Only a send that names its marketing
      -- recipients (req->'ramp', admission.ts charges) is asked; transactional mail never is.
      IF jsonb_typeof(h)='object' AND NOT sim AND jsonb_typeof(req->'ramp')='object' THEN
        d := ramp_refusal(wid,req->'ramp');
        IF d IS NOT NULL THEN EXIT decide; END IF;
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
