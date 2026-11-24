SET LOCAL lock_timeout='2s';
-- Send fairness and work-conserving shared-pool pacing (docs/sending-limits.md):
-- 1. Good-standing shared workspaces (graded, daily_limit IS NULL, step in ok/notice, past growth, no active override
--    or resume restore cap) plan and pace at the full pool SES rate instead of a hard quarter, while keeping a 0.5x
--    per-sending-domain minute cap (hosted_burst_ok: cap / 2) as a softer guard and round-robin 1:1 fair share across
--    concurrent marketing workspaces in the dispatcher. Evaluation, 24h growth, score caps, freezes, overrides, restore
--    caps and the 50% customer daily share remain unchanged.
-- 2. Truly transactional mail (not campaign, not bulk-flagged) from a good-standing pool-paced workspace is exempt from
--    the shared-pool minute/domain burst cap so a customer's marketing campaign never blocks its own password resets;
--    hosted_growth and daily-capped/evaluation/override minute caps remain enforced on every stream.
-- 3. Tighten per-table autovacuum thresholds on sending_emails (SHARE UPDATE EXCLUSIVE only, no rewrite) so partial
--    dispatch queue indexes do not accumulate hundreds of thousands of dead tuples during multi-million-row sends.

CREATE OR REPLACE FUNCTION hosted_pool_pace(wid text) RETURNS int LANGUAGE sql STABLE AS $$
  SELECT greatest(500, floor(60 * coalesce((SELECT max(l.max_send_rate) FROM provider_account_limits l WHERE l.aws_account_id = c.aws_account_id), 0))::int)
  FROM provider_connections c WHERE c.workspace_id = wid AND c.kind = 'shared'
$$;

CREATE OR REPLACE FUNCTION hosted_pool_paced(wid text) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1 FROM workspaces w
    JOIN provider_connections c ON c.workspace_id = w.id AND c.kind = 'shared'
    JOIN sender_standing s ON s.workspace_id = w.id
    WHERE w.id = wid AND NOT w.exempt_hosted_quotas
      AND (w.send_cap_override IS NULL OR w.send_cap_override_expires_at <= now())
      AND (c.restore_cap IS NULL OR c.restore_until <= now())
      AND s.phase = 'graded' AND s.daily_limit IS NULL AND s.step IN ('ok', 'notice')
  )
$$;

CREATE OR REPLACE FUNCTION hosted_minute_cap(wid text) RETURNS int LANGUAGE sql STABLE AS $$
  SELECT CASE
    WHEN o.daily IS NULL AND s.workspace_id IS NOT NULL AND s.daily_limit IS NULL
      AND (c.restore_cap IS NULL OR c.restore_until <= now())
      AND s.phase = 'graded' AND s.step IN ('ok', 'notice')
    THEN CASE
      WHEN s.growth_until > now() AND s.growth_cap IS NOT NULL THEN greatest(500, floor(hosted_pool_pace(wid) / 4.0)::int)
      ELSE hosted_pool_pace(wid)
    END
    ELSE greatest(least(500, greatest(50, coalesce(o.daily, least(s.daily_limit, CASE WHEN c.restore_until > now() THEN c.restore_cap END)) / 20)), ceil(o.daily / 1440.0)::int)
  END
  FROM workspaces w JOIN provider_connections c ON c.workspace_id = w.id AND c.kind = 'shared' LEFT JOIN sender_standing s ON s.workspace_id = w.id
    CROSS JOIN LATERAL (SELECT CASE WHEN w.send_cap_override_expires_at IS NULL OR w.send_cap_override_expires_at > now() THEN w.send_cap_override END AS daily) o
  WHERE w.id = wid
$$;

-- Replace the 3-arg function atomically with a 4-arg version defaulting is_transactional=false so in-flight callers
-- from the previous release keep working without overload ambiguity during rollout.
DROP FUNCTION IF EXISTS hosted_burst_ok(text, text, int);
CREATE OR REPLACE FUNCTION hosted_burst_ok(wid text, domain_key text, cost int, is_transactional boolean DEFAULT false) RETURNS boolean LANGUAGE plpgsql VOLATILE AS $$
DECLARE cap int; tenant int; dom int; sponsor text; gkey text; gcap int; gused int; pool_only boolean; tick timestamptz:=date_trunc('minute',statement_timestamp());
BEGIN
 IF cost=0 THEN RETURN true; END IF;
 SELECT hosted_minute_cap(wid),
   CASE WHEN p.send_cap_override IS NULL OR w.send_cap_override_expires_at<=now() THEN w.quota_sponsor END,
   hosted_pool_paced(wid)
 INTO cap,sponsor,pool_only
 FROM hosted_admission_policy p JOIN workspaces w ON w.id=p.workspace_id WHERE p.workspace_id=wid AND NOT p.exempt_hosted_quotas;
 IF NOT FOUND THEN RETURN true; END IF;
 IF NOT (is_transactional AND pool_only) THEN
   INSERT INTO hosted_burst_windows VALUES(wid,'',tick,0) ON CONFLICT DO NOTHING;
   SELECT CASE WHEN minute=tick THEN used ELSE 0 END INTO tenant FROM hosted_burst_windows WHERE workspace_id=wid AND scope='' FOR UPDATE;
   SELECT used INTO dom FROM hosted_burst_windows WHERE workspace_id=wid AND scope=domain_key AND minute=tick;
   IF tenant+cost>cap OR coalesce(dom,0)+cost>greatest(50,cap/2) THEN RETURN false; END IF;
 END IF;
 SELECT g.key,g.cap INTO gkey,gcap FROM hosted_growth(wid) g;
 IF gkey IS NOT NULL THEN
   -- The current minute's row is the sponsor's lock: claims of its growing workspaces count the hour one at a time.
   INSERT INTO hosted_growth_minutes AS m VALUES(gkey,tick,0) ON CONFLICT ON CONSTRAINT hosted_growth_minutes_pkey DO UPDATE SET used=m.used WHERE false;
   SELECT coalesce(sum(m.used),0) INTO gused FROM hosted_growth_minutes m WHERE m.growth_key=gkey AND m.minute>tick-interval '60 minutes';
   IF gused+cost>gcap THEN RETURN false; END IF;
 END IF;
 IF NOT (is_transactional AND pool_only) THEN
   IF sponsor IS NOT NULL THEN
     INSERT INTO hosted_burst_windows AS b VALUES(sponsor,'#sponsor',tick,cost) ON CONFLICT(workspace_id,scope) DO UPDATE SET
       minute=tick,used=cost+CASE WHEN b.minute=tick THEN b.used ELSE 0 END WHERE b.minute<>tick OR b.used+cost<=cap;
     IF NOT FOUND THEN RETURN false; END IF;
   END IF;
   UPDATE hosted_burst_windows SET used=tenant+cost,minute=tick WHERE workspace_id=wid AND scope='';
   INSERT INTO hosted_burst_windows VALUES(wid,domain_key,tick,coalesce(dom,0)+cost) ON CONFLICT(workspace_id,scope) DO UPDATE SET minute=tick,used=excluded.used;
 END IF;
 IF gkey IS NOT NULL THEN UPDATE hosted_growth_minutes m SET used=m.used+cost WHERE m.growth_key=gkey AND m.minute=tick; END IF;
 RETURN true;
END $$;

CREATE OR REPLACE VIEW regional_workspace_limits AS SELECT c.workspace_id,l.aws_account_id,l.region,l.refresh_after,l.checked_at,
  CASE WHEN c.kind='shared'
    AND NOT coalesce((SELECT w.exempt_hosted_quotas FROM workspaces w WHERE w.id=c.workspace_id),false)
    AND NOT (hosted_pool_paced(c.workspace_id) AND NOT EXISTS (SELECT 1 FROM hosted_growth(c.workspace_id)))
  THEN l.max_send_rate/4 ELSE l.max_send_rate END AS max_send_rate,
  l.max_24_hour_send,l.sent_last_24_hours,l.customer_sent_24_hours
  FROM regional_simulated_connections c JOIN provider_account_limits l USING(aws_account_id,region);

ALTER TABLE sending_emails SET (
  autovacuum_vacuum_scale_factor = 0.005,
  autovacuum_vacuum_threshold = 5000,
  autovacuum_analyze_scale_factor = 0.01,
  autovacuum_analyze_threshold = 5000
);
