SET LOCAL lock_timeout='2s';
-- A new sender's start (docs/sending-limits.md): the evaluation is a workspace's first 500 real recipients (was 100) and
-- the growth pace after it lasts 24 clean hours (was 72). Both numbers live in src/standing-model.ts (EVALUATION,
-- GROWTH): the standing job stores the evaluation's limit and the growth's end, and admission is passed the limit of a
-- workspace the job has not seen yet (first_week). No function repeats them after this one (sender_standing's column
-- default, 100, is never used: the API inserts every row with the evaluation's limit).
--
-- 1. No transactional reserve during the evaluation. The reserve, max(100, headroom%) of the limit, took all of the
--    evaluation's 100, so marketing had 0: a sender of newsletters alone could not send its first campaign (it waited
--    on hosted_daily_quota forever) or finish the evaluation, and a batch of 10 identical transactional emails, bulk
--    evidence charged as marketing (hosted-sending.ts bulkFlags), was refused. The evaluation lifts within about an
--    hour of its last recipient, so there is nothing for the reserve to keep; marketing may use all of it, still at most
--    max(25, limit / 4) an hour. Score limits and overrides keep their reserve, unchanged.
-- 2. hosted_minute_cap no longer assumes the evaluation's limit for a workspace the job has not seen: it paces it at the
--    floor, 50 a minute, as clamp(limit / 20, 50, 500) gave for 100 and gives for 500.
-- 3. A workspace already in the growth pace ends it 24 clean hours after it started (or after a ladder step restarted
--    it), not 72.
--
-- Locks: the two CREATE OR REPLACE FUNCTION statements take no lock admission or dispatch wait on (callers do not lock
-- functions; each statement reads the definition it started with). The UPDATE takes ROW EXCLUSIVE on sender_standing,
-- which conflicts with no reads or row writes, and row locks on the rows still in the growth pace (a sequential scan of
-- one row per Hosted workspace), waiting at most lock_timeout for a standing job's transaction on one of them.

-- Unchanged from 348 except the reserve: none during the evaluation.
CREATE OR REPLACE FUNCTION hosted_allowance_read(wid text,incoming int,marketing int,first_week int,second_week int,mature int,headroom numeric)
RETURNS TABLE(allowance jsonb) LANGUAGE sql STABLE AS $$
 WITH policy AS MATERIALIZED (
   SELECT p.*,s.step,coalesce(s.marketing_hold,false) AS operator_hold,
     CASE WHEN s.release_until>now() THEN s.release_percent END AS release_percent,
     CASE WHEN w.send_cap_override_expires_at IS NULL OR w.send_cap_override_expires_at>now() THEN p.send_cap_override END AS override,
     CASE WHEN NOT p.exempt_hosted_quotas AND (p.send_cap_override IS NULL OR w.send_cap_override_expires_at<=now()) THEN w.quota_sponsor END AS sponsor,
     hosted_base_cap(wid,first_week,second_week,mature) AS full_cap,hosted_sponsor_hold(wid) AS sponsor_hold,
     -- In its evaluation until its first grade (no standing yet included), as hosted-sending.ts probationReason says.
     coalesce(s.phase,'calibrating')<>'graded' AS evaluating
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
     (greatest(0,p.cap-CASE WHEN p.override IS NOT NULL THEN ceil(p.cap*headroom/100)::int WHEN p.evaluating THEN 0 ELSE greatest(least(100,p.cap),ceil(p.cap*headroom/100)::int) END)
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

-- Unchanged from 348 except the fallback: a workspace without a standing row or an override gets the floor.
CREATE OR REPLACE FUNCTION hosted_minute_cap(wid text) RETURNS int LANGUAGE sql STABLE AS $$
  SELECT CASE WHEN o.daily IS NULL AND s.workspace_id IS NOT NULL AND s.daily_limit IS NULL THEN hosted_pool_pace(wid)
    ELSE greatest(least(500,greatest(50,coalesce(o.daily,s.daily_limit)/20)),ceil(o.daily/1440.0)::int) END
  FROM workspaces w JOIN provider_connections c ON c.workspace_id=w.id AND c.kind='shared' LEFT JOIN sender_standing s ON s.workspace_id=w.id
    CROSS JOIN LATERAL (SELECT CASE WHEN w.send_cap_override_expires_at IS NULL OR w.send_cap_override_expires_at>now() THEN w.send_cap_override END AS daily) o
  WHERE w.id=wid
$$;

UPDATE sender_standing SET growth_until=growth_until-interval '48 hours' WHERE growth_until>now();
