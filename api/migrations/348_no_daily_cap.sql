SET LOCAL lock_timeout='2s';
-- No daily limit for a sender in good standing (docs/sending-limits.md). The standing job (src/standing.ts) now stores
-- NULL as a workspace's daily limit when its score is 75 or more and no ladder step froze it; under 75 it stores the
-- score's band (500, 200 or 100), and the evaluation (the first 100 real recipients) keeps 100. Admission already treats
-- a NULL limit as no daily limit (an exempt workspace's); this makes the stored NULL reach it, keeps a resume's reduced
-- limit applying without one, and paces a workspace without one by the pool instead of by a limit it no longer has.
-- Replaces the daily ramp (a score from 65 rising at most +5 a day, up to 10,000): existing workspaces are re-graded by
-- the job's next runs, within six hours; until then admission reads the limit they have.
ALTER TABLE sender_standing ALTER COLUMN daily_limit DROP NOT NULL, ALTER COLUMN band_limit DROP NOT NULL;
COMMENT ON COLUMN sender_standing.daily_limit IS 'Recipients per rolling 24 hours admission enforces; NULL: no daily limit (good standing).';

-- The limit before any resume restore: an active operator override, nothing when exempt, else the standing's limit, NULL
-- when it has none (first_week only for a workspace the standing job has not seen yet).
CREATE OR REPLACE FUNCTION hosted_base_cap(wid text,first_week int,second_week int,mature int) RETURNS int LANGUAGE sql STABLE AS $$
  SELECT coalesce(CASE WHEN w.send_cap_override_expires_at IS NULL OR w.send_cap_override_expires_at>now() THEN w.send_cap_override END,
    CASE WHEN NOT w.exempt_hosted_quotas THEN CASE WHEN s.workspace_id IS NULL THEN first_week ELSE s.daily_limit END END)
  FROM workspaces w LEFT JOIN sender_standing s ON s.workspace_id=w.id WHERE w.id=wid
$$;

-- Unchanged from 231 except the restore: before, a resume's reduced limit applied only on top of a base limit.
CREATE OR REPLACE FUNCTION hosted_allowance_read(wid text,incoming int,marketing int,first_week int,second_week int,mature int,headroom numeric)
RETURNS TABLE(allowance jsonb) LANGUAGE sql STABLE AS $$
 WITH policy AS MATERIALIZED (
   SELECT p.*,s.step,coalesce(s.marketing_hold,false) AS operator_hold,
     CASE WHEN s.release_until>now() THEN s.release_percent END AS release_percent,
     CASE WHEN w.send_cap_override_expires_at IS NULL OR w.send_cap_override_expires_at>now() THEN p.send_cap_override END AS override,
     CASE WHEN NOT p.exempt_hosted_quotas AND (p.send_cap_override IS NULL OR w.send_cap_override_expires_at<=now()) THEN w.quota_sponsor END AS sponsor,
     hosted_base_cap(wid,first_week,second_week,mature) AS full_cap,hosted_sponsor_hold(wid) AS sponsor_hold
   FROM hosted_admission_policy_read p JOIN workspaces w ON w.id=p.workspace_id LEFT JOIN sender_standing s ON s.workspace_id=p.workspace_id
   WHERE p.workspace_id=wid
 ), capped AS (
   -- A resume's reduced limit applies without a base limit too (least ignores the NULL): only an exempt workspace has none.
   SELECT p.*,CASE WHEN (p.full_cap IS NOT NULL OR NOT p.exempt_hosted_quotas) AND p.restore_cap IS NOT NULL AND p.restore_until>now() THEN p.restore_until END AS restored_until,
     CASE WHEN (p.full_cap IS NOT NULL OR NOT p.exempt_hosted_quotas) AND p.restore_cap IS NOT NULL AND p.restore_until>now() THEN least(p.full_cap,p.restore_cap) ELSE p.full_cap END AS cap FROM policy p
 ), siblings AS (
   SELECT wid AS id UNION ALL SELECT w.id FROM workspaces w WHERE w.id<>wid AND w.quota_sponsor=(SELECT sponsor FROM capped)
     AND (w.send_cap_override IS NULL OR w.send_cap_override_expires_at<=now()) AND NOT w.exempt_hosted_quotas
 ), hours AS (
   SELECT h.hour,sum(h.recipients) AS recipients,coalesce(sum(h.marketing) FILTER (WHERE h.workspace_id=wid),0) AS marketing FROM siblings s JOIN hosted_usage_hourly h ON h.workspace_id=s.id
   WHERE incoming>0 AND h.hour BETWEEN date_trunc('hour',now(),'UTC')-interval '23 hours' AND date_trunc('hour',now(),'UTC') AND h.recipients>0 GROUP BY h.hour
 ), usage AS (SELECT hour,sum(recipients) OVER(ORDER BY hour DESC) AS running FROM hours)
 SELECT jsonb_build_object('cap',p.cap,'marketingCap',CASE WHEN hr.binding THEN u.used+greatest(0,hr.cap-hr.used) ELSE m.cap END,'marketingDayCap',m.cap,'used',u.used,'resetAt',u.reset,
   'nextChangeAt',least(p.restored_until,coalesce(u.first_expiry,date_trunc('hour',now(),'UTC')+interval '24 hours'),CASE WHEN hr.binding THEN hr.reset END),
   'marketingHourCap',hr.cap,'marketingHourUsed',hr.used,'marketingHourResetAt',CASE WHEN hr.cap IS NOT NULL THEN hr.reset END,
   'pauseReason',coalesce(p.pause_reason,CASE WHEN p.sponsor_hold='pause' THEN 'Hosted sending is paused for another workspace of this account. Bane reviews it before this workspace can send.' END),
   'pendingCapOverride',p.pending_cap_override,'exemptHostedQuotas',p.exempt_hosted_quotas,
   'nextCap',CASE WHEN p.restored_until IS NOT NULL AND p.full_cap>p.cap THEN p.full_cap END,'nextCapAt',CASE WHEN p.restored_until IS NOT NULL AND p.full_cap>p.cap THEN p.restored_until END,
   'marketingHeld',coalesce((p.step IN ('restrict','pause') AND p.release_percent IS NULL) OR p.operator_hold,false) OR p.marketing_held_at IS NOT NULL OR p.sponsor_hold IS NOT NULL,
   'marketingHoldReason',CASE WHEN NOT coalesce((p.step IN ('restrict','pause') AND p.release_percent IS NULL) OR p.operator_hold,false) THEN p.marketing_hold_reason END,'step',coalesce(p.step,'ok'))
 FROM capped p CROSS JOIN LATERAL (SELECT CASE WHEN p.cap IS NOT NULL THEN
     (greatest(0,p.cap-CASE WHEN p.override IS NULL THEN greatest(least(100,p.cap),ceil(p.cap*headroom/100)::int) ELSE ceil(p.cap*headroom/100)::int END)
       *coalesce(p.release_percent,100)/100) END AS cap) m CROSS JOIN LATERAL (
   SELECT coalesce(max(running),0) AS used,min(hour)+interval '24 hours' AS first_expiry,
     max(hour) FILTER(WHERE running+least(incoming,p.cap)>p.cap OR (marketing>0 AND running+least(marketing,m.cap)>m.cap))+interval '24 hours' AS reset FROM usage) u
   -- Marketing per hour, per workspace (parallel campaigns and direct marketing share it): max(25, limit / 4). It is
   -- folded into marketingCap when it binds, so every check of marketingCap (one-statement admission, the session
   -- path, campaign release) enforces it, and nextChangeAt says when the next hour starts.
   CROSS JOIN LATERAL (SELECT c.cap,c.used,date_trunc('hour',now(),'UTC')+interval '1 hour' AS reset,c.cap IS NOT NULL AND u.used+greatest(0,c.cap-c.used)<m.cap AS binding FROM (
     SELECT CASE WHEN p.cap IS NOT NULL THEN greatest(25,p.cap/4) END AS cap,
       coalesce((SELECT h.marketing FROM hours h WHERE h.hour=date_trunc('hour',now(),'UTC')),0) AS used) c) hr
$$;

-- Pacing, per fixed minute, is platform protection, not a customer limit. With a daily limit (or an override) it is
-- unchanged from 231: clamp(limit ÷ 20, 50, 500), at least override ÷ 1440. Without one: a quarter of the pool account's
-- SES rate a minute (the share campaign planning gives a shared workspace, provider_workspace_limits), at least 500,
-- today's largest. hosted_burst_ok gives each sending domain half of it (at least 50), and the dispatcher's lease gives
-- every workspace with queued mail a slot before any gets a second, under the pool's own rate.
CREATE OR REPLACE FUNCTION hosted_minute_cap(wid text) RETURNS int LANGUAGE sql STABLE AS $$
  SELECT CASE WHEN o.daily IS NULL AND s.workspace_id IS NOT NULL AND s.daily_limit IS NULL
      THEN greatest(500,floor(60*coalesce((SELECT max(l.max_send_rate) FROM provider_account_limits l WHERE l.aws_account_id=c.aws_account_id),0)/4)::int)
    ELSE greatest(least(500,greatest(50,coalesce(o.daily,s.daily_limit,100)/20)),ceil(o.daily/1440.0)::int) END
  FROM workspaces w JOIN provider_connections c ON c.workspace_id=w.id AND c.kind='shared' LEFT JOIN sender_standing s ON s.workspace_id=w.id
    CROSS JOIN LATERAL (SELECT CASE WHEN w.send_cap_override_expires_at IS NULL OR w.send_cap_override_expires_at>now() THEN w.send_cap_override END AS daily) o
  WHERE w.id=wid
$$;
