SET LOCAL lock_timeout='2s';
-- A route made over MCP is owned by its approval (mail_grant_objects kind 'route'): removing the approval disables it
-- (mail_disable_grant_object). Since approvals follow the account service's sign-in tokens (273), mail_management_grant
-- also ends one when its newest token expires, minutes after the agent's last call. The claim and the delivery checked
-- routes with it, so a route made over MCP stopped routing whenever its agent was not connected: its address fell back
-- to its own inbox and the route's webhooks got nothing. A route now needs its approval to stand: not removed, and its
-- person still an owner or admin of the workspace with manage. The keys and webhooks an approval made (approval-ties.ts)
-- and its rules keep the stricter rule.
CREATE FUNCTION mail_route_grant(w text, gid text, policy jsonb) RETURNS boolean LANGUAGE sql AS $$
  SELECT EXISTS(SELECT FROM nightmail_resource_grants g
    JOIN nightmail_oidc_identities i USING(issuer,subject) JOIN nightmail_users u ON u.id=i.user_id
    JOIN workspace_members m ON m.user_id=i.user_id AND m.workspace_id=w
    WHERE g.grant_key=gid AND g.issuer=policy->>'issuer' AND NOT g.revoked
    AND (coalesce((policy->>'hosted')::boolean,false) OR coalesce(policy->'subjects','[]'::jsonb) ? i.subject)
    AND m.role IN ('owner','admin') AND 'manage'=ANY(g.permissions) FOR SHARE OF g,i,u,m);
$$;

-- The claim adds routeGrants, the route owners that stand, which gate routes. grants, the active owners, is unchanged: it
-- still gates rules, and the release before this one gates routes with it while this one rolls out.
CREATE OR REPLACE FUNCTION mail_route_input(w text, recipients jsonb,force_read boolean DEFAULT false,policy jsonb DEFAULT NULL) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE p jsonb; route_owners jsonb; live jsonb; standing jsonb;
BEGIN
 p:=mail_route_input_unfenced(w,recipients,force_read); IF p IS NULL THEN RETURN NULL; END IF;
 SELECT jsonb_object_agg(resource,ids) INTO route_owners FROM (SELECT resource,jsonb_agg(grant_id) AS ids FROM mail_grant_objects WHERE workspace_id=w AND kind='route' AND resource IN (SELECT value->>'id' FROM jsonb_each(nullif(p->'exact','null')) UNION SELECT r->>'id' FROM jsonb_each(nullif(p->'hosts','null')) h CROSS JOIN jsonb_array_elements(h.value->'patterns') r) GROUP BY resource) owners;
 SELECT jsonb_agg(gid) INTO live FROM (SELECT jsonb_array_elements_text(value) AS gid FROM jsonb_each(route_owners) UNION SELECT value FROM jsonb_each_text(p#>'{programs,owners}') WHERE value IS NOT NULL) deps WHERE mail_receiving_grant(w,gid,policy);
 SELECT jsonb_agg(gid) INTO standing FROM (SELECT DISTINCT jsonb_array_elements_text(value) AS gid FROM jsonb_each(route_owners)) deps WHERE mail_route_grant(w,gid,policy);
 RETURN p||jsonb_strip_nulls(jsonb_build_object('routeOwners',route_owners,'grants',live,'routeGrants',standing));
END $$;

-- The store rechecks both under the same locks: a removal that commits after the claim reclaims the receipt.
CREATE OR REPLACE FUNCTION mail_store_incoming(msg jsonb,file_items jsonb,refs_json jsonb,envelopes jsonb,authenticated_from boolean,can_create boolean,plan jsonb,policy jsonb DEFAULT NULL) RETURNS TABLE(queued_count integer,wait_ms double precision,hold_ms double precision) LANGUAGE plpgsql AS $$
DECLARE gid text;
BEGIN
 FOR gid IN SELECT jsonb_array_elements_text(plan->'grants') LOOP
   IF NOT mail_receiving_grant(msg->>'workspace_id',gid,policy) THEN RAISE EXCEPTION 'Grant changed; reclaim receipt' USING ERRCODE='40001'; END IF;
 END LOOP;
 FOR gid IN SELECT jsonb_array_elements_text(plan->'routeGrants') LOOP
   IF NOT mail_route_grant(msg->>'workspace_id',gid,policy) THEN RAISE EXCEPTION 'Grant changed; reclaim receipt' USING ERRCODE='40001'; END IF;
 END LOOP;
 RETURN QUERY SELECT * FROM mail_store_ritual_plan(msg,file_items,refs_json,envelopes,authenticated_from,can_create,plan);
END $$;
