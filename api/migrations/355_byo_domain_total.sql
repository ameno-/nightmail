SET LOCAL lock_timeout='1s';
-- A workspace that sends through its own AWS account keeps its identities in that account's SES, so the workspace's
-- domain total (342) no longer applies to it. The 10-unproven limit still does. The two reservations, as 342 left them,
-- with the total skipped for a bring-your-own connection.
CREATE OR REPLACE FUNCTION reserve_domain_claim(wid text, host text, requested_region text, new_id text, importing text DEFAULT NULL) RETURNS TABLE
  (connection jsonb, token uuid, id text, readiness jsonb, fresh boolean, error_code text)
LANGUAGE plpgsql VOLATILE SECURITY INVOKER AS $$
DECLARE pc provider_connections%ROWTYPE; claim domain_claims%ROWTYPE;
BEGIN
  -- Serialize the workspace count + insert, including concurrent reservations on unrelated names.
  -- Settings first, as in disconnect/import; only then take the cross-workspace overlap lock.
  SELECT c.* INTO pc FROM ses_installation_settings s JOIN provider_connections c USING(workspace_id)
    WHERE s.workspace_id=wid AND c.region=requested_region AND
      ((importing IS NULL AND c.state='ready') OR (c.id=importing AND c.kind='byo' AND c.state='provisioning')) FOR NO KEY UPDATE OF s FOR SHARE OF c;
  IF NOT FOUND THEN RETURN NEXT; RETURN; END IF;
  connection := to_jsonb(pc);
  PERFORM pg_advisory_xact_lock(hashtextextended(substring(host FROM '[^.]+\.[^.]+$'),84912));
  SELECT dc.* INTO claim FROM domain_claims dc WHERE dc.workspace_id=wid AND dc.name=host FOR UPDATE;
  fresh := NOT FOUND;
  IF importing IS NULL AND coalesce(claim.claim_scope,'exclusive')<>'account' AND exclusive_domain_overlap(wid,host) THEN RETURN NEXT; RETURN; END IF;
  IF fresh THEN
    IF (SELECT (pc.kind<>'byo' AND count(*)>=workspace_domain_limit(wid)) OR (importing IS NULL AND count(*) FILTER (WHERE NOT dc.ever_proven)>=10) FROM domain_claims dc WHERE dc.workspace_id=wid) THEN
      error_code := 'DOMAIN_LIMIT_REACHED'; RETURN NEXT; RETURN;
    END IF;
    INSERT INTO domain_claims(name,workspace_id,connection_id,claim_scope) VALUES(host,wid,pc.id,CASE WHEN importing IS NULL THEN 'exclusive' ELSE 'account' END) RETURNING * INTO claim;
  ELSIF importing IS NULL AND domain_claim_expired(claim) THEN
    error_code := 'DOMAIN_CLAIM_EXPIRED'; RETURN NEXT; RETURN;
  ELSIF claim.workspace_id=wid AND claim.connection_id IS NULL THEN
    fresh := true;
    UPDATE domain_claims dc SET connection_id=pc.id,claim_scope=CASE WHEN importing IS NOT NULL AND dc.claim_scope<>'txt' THEN 'account' ELSE dc.claim_scope END
      WHERE dc.workspace_id=wid AND dc.name=host RETURNING * INTO claim;
  ELSIF claim.workspace_id=wid AND claim.connection_id=pc.id THEN
    SELECT d.id INTO id FROM operation_domains d WHERE d.workspace_id=wid AND d.name=host AND d.region=requested_region;
    token := claim.token; RETURN NEXT; RETURN;
  ELSE RETURN NEXT; RETURN;
  END IF;
  token := claim.token;
  INSERT INTO operation_domains AS d(id,name,workspace_id,region) VALUES(new_id,host,wid,requested_region)
    ON CONFLICT ON CONSTRAINT operation_domain_scope DO UPDATE SET updated_at=now() RETURNING d.id INTO id;
  IF importing IS NULL THEN
    INSERT INTO jobs(id,workspace_id,type,payload,available_at) VALUES('domain.verify:'||claim.token,wid,'domain.verify',
      jsonb_build_object('domainId',id,'token',claim.token,'start',floor(extract(epoch FROM now())*1000)),now()+interval '5 seconds')
      ON CONFLICT ON CONSTRAINT jobs_pkey DO UPDATE SET payload=excluded.payload,available_at=excluded.available_at,status='pending',lease_until=NULL;
  END IF;
  RETURN NEXT;
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
    IF (SELECT (pc.kind<>'byo' AND count(*)>=workspace_domain_limit(wid)) OR (importing IS NULL AND count(*) FILTER(WHERE NOT dc.ever_proven)>=10) FROM domain_claims dc WHERE dc.workspace_id=wid) THEN
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
