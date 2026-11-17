-- One Idempotency-Key protocol on sending_idempotency (src/idempotency.ts). Every caller claims a key here: the
-- create middleware, idempotent() (campaigns, uploads, mailbox and thread sends, self-hosted and template sends) and
-- the one-statement direct admission below. A concurrent duplicate no longer waits on the first request's unique
-- insert: while that request's transaction holds the key, the duplicate gets 409 IDEMPOTENCY_IN_PROGRESS at once.
--
-- Returns NULL when this request now owns the key. Otherwise {previous, hash, createdAt} of the committed claim
-- (previous is its stored result, NULL while a multi-step create is still running), or {previous: null, busy: true}
-- while another open transaction holds the key. The try-lock never waits, so it cannot join a lock cycle. A holder
-- that releases its claim between this INSERT and the read leaves the key free: claim it on the second pass.
CREATE FUNCTION idempotency_claim(wid text, actor text, route text, idem text, body_hash text, receipt jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE AS $$
DECLARE previous jsonb;
BEGIN
  IF NOT pg_try_advisory_xact_lock(hashtextextended(jsonb_build_array(wid, actor, route, idem)::text, 71953)) THEN
    RETURN jsonb_build_object('previous', NULL, 'busy', true);
  END IF;
  FOR pass IN 1..2 LOOP
    INSERT INTO sending_idempotency(workspace_id, actor_key_id, path, request_key, request_hash, result)
      VALUES (wid, actor, route, idem, body_hash, receipt) ON CONFLICT DO NOTHING;
    IF FOUND THEN RETURN NULL; END IF;
    -- A volatile function's next statement takes a new snapshot: it sees the claim the INSERT conflicted with.
    SELECT jsonb_build_object('previous', result, 'hash', request_hash, 'createdAt', created_at) INTO previous
      FROM sending_idempotency WHERE workspace_id = wid AND actor_key_id = actor AND path = route AND request_key = idem;
    IF previous IS NOT NULL THEN RETURN previous; END IF;
  END LOOP;
  RETURN jsonb_build_object('previous', NULL, 'busy', true);
END $$;

-- 064's function with its claim replaced by idempotency_claim; the rest is unchanged. key_admission_decision returns
-- any state with 'previous' to the caller, which applies the replay rule.
CREATE OR REPLACE FUNCTION direct_admission_state(wid text,actor_id text,route text,idem_key text,body_hash text,receipt jsonb,
  wanted jsonb,asset_ids jsonb,simulated boolean,incoming int,marketing int,first_week int,second_week int,mature int,headroom numeric)
RETURNS jsonb LANGUAGE plpgsql VOLATILE AS $$
DECLARE previous jsonb; state jsonb;
BEGIN
  IF idem_key IS NOT NULL THEN
    previous := idempotency_claim(wid, actor_id, route, idem_key, body_hash, receipt);
    IF previous IS NOT NULL THEN RETURN previous; END IF;
  END IF;
  INSERT INTO job_schedule(workspace_id) VALUES(wid) ON CONFLICT(workspace_id) DO UPDATE SET turn=job_schedule.turn WHERE false;
  WITH settings AS (SELECT default_region,enabled_regions FROM ses_installation_settings WHERE workspace_id=wid FOR SHARE),
  connection AS (SELECT region,kind,aws_account_id,tenant_state FROM provider_simulated_connections WHERE simulated AND workspace_id=wid
    UNION ALL SELECT region,kind,aws_account_id,tenant_state FROM provider_sending_connections WHERE NOT simulated AND workspace_id=wid)
  SELECT (SELECT to_jsonb(p) FROM direct_pending_load(wid,jsonb_array_length(wanted),jsonb_array_length(jsonb_path_query_array(wanted,'$[*] ? (@.kind == "marketing")'))) p) || jsonb_build_object(
    'hosted',(SELECT allowance FROM hosted_allowance(wid,incoming,marketing,first_week,second_week,mature,headroom)),
    'quota',(SELECT max(l.max_24_hour_send) FROM provider_workspace_limits l JOIN provider_connections pc USING(workspace_id,region) WHERE l.workspace_id=wid AND pc.kind='byo'),
    'default_region',s.default_region,'enabled_regions',s.enabled_regions,'connection',to_jsonb(c),
    'assets',CASE WHEN jsonb_array_length(asset_ids)>0 THEN (SELECT jsonb_agg(asset) FROM (
      SELECT id,size,content_id AS "contentId" FROM sending_attachments WHERE workspace_id=wid AND id IN (SELECT jsonb_array_elements_text(asset_ids))
      ORDER BY id FOR UPDATE) asset) END,
    'verified',ARRAY(SELECT m.host||':'||coalesce(m.region,s.default_region) FROM jsonb_to_recordset(wanted) m(host text,region text)
      WHERE EXISTS(SELECT FROM verified_sending_domains d WHERE d.workspace_id=wid AND d.region=coalesce(m.region,s.default_region)
          AND right('.'||m.host,length(d.name)+1)='.'||d.name))) INTO state
  FROM (VALUES(1)) anchor(i) LEFT JOIN settings s ON true LEFT JOIN connection c ON c.region=coalesce(wanted->0->>'region',s.default_region);
  RETURN state;
END $$;
