SET LOCAL lock_timeout='2s';
-- Billing fixes from a review of hosted billing (2026-11-15), one section each.

-- Usage is priced under the mode it was metered in. Settlement used to take the mode at settle time, so usage
-- metered while billing was off (or in shadow, or while a workspace was free) was charged once it was priced
-- later, and the last open hour before a workspace became free was forgiven. Now a mode change settles first:
-- set-billing-enforcement settles every workspace under the old installation mode (billing_settle_all) and
-- billing_free_sync settles the workspace under its old mode. Switching to 'off' doesn't settle: the kill-switch
-- must not depend on the settler, and what it leaves open is then priced at $0 when billing comes back on.
--
-- The switch is a fence. Every meter write first takes billing_meter_fence's shared locks (the installation's and its
-- workspace's) until its transaction ends; a switch takes the installation's (or the workspace's) exclusively, so it
-- waits for the writes in flight, settles with no writer running, and every write that commits after it is the new
-- mode's. At the switch the settler also waits for usage rows instead of skipping a locked one.
CREATE FUNCTION billing_meter_fence(wid text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_advisory_xact_lock_shared(31401, 0);
  PERFORM pg_advisory_xact_lock_shared(31402, hashtext(wid));
END $$;

-- Settles a workspace up to now under its current mode, waiting for its account and every open usage row.
CREATE FUNCTION billing_settle_switch(wid text) RETURNS jsonb LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO billing_accounts(workspace_id) VALUES (wid) ON CONFLICT DO NOTHING;
  PERFORM 1 FROM billing_accounts WHERE workspace_id=wid FOR UPDATE;
  PERFORM 1 FROM billing_usage_hourly WHERE workspace_id=wid AND (quantity <> settled_quantity OR refunds <> '{}')
    ORDER BY hour, meter, rate_version FOR UPDATE;
  RETURN billing_settle(wid, 'infinity');
END $$;

CREATE FUNCTION billing_settle_all() RETURNS int LANGUAGE plpgsql AS $$
DECLARE w text; n int := 0;
BEGIN
  PERFORM pg_advisory_xact_lock(31401, 0);
  FOR w IN SELECT DISTINCT workspace_id FROM billing_usage_hourly WHERE quantity <> settled_quantity OR refunds <> '{}' ORDER BY 1 LOOP
    PERFORM billing_settle_switch(w);
    n := n + 1;
  END LOOP;
  RETURN n;
END $$;

CREATE OR REPLACE FUNCTION billing_free_sync(wid text) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE s jsonb; old text; target text; m text;
BEGIN
  IF (billing_free_state(wid)->>'free')::boolean THEN INSERT INTO billing_accounts(workspace_id) VALUES (wid) ON CONFLICT DO NOTHING; END IF;
  SELECT mode INTO old FROM billing_accounts WHERE workspace_id=wid FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('free', false, 'via', null, 'until', null, 'mode', 'prepaid'); END IF;
  s := billing_free_state(wid);
  target := CASE WHEN (s->>'free')::boolean THEN 'exempt' ELSE (SELECT paid_mode FROM billing_accounts WHERE workspace_id=wid) END;
  IF target <> old AND (SELECT mode FROM billing_config WHERE singleton) <> 'off' THEN
    PERFORM pg_advisory_xact_lock(31402, hashtext(wid));
    PERFORM billing_settle_switch(wid);
  END IF;
  UPDATE billing_accounts SET mode=target, free_via=s->>'via', updated_at=now()
    WHERE workspace_id=wid AND (mode, free_via) IS DISTINCT FROM (target, s->>'via');
  SELECT mode INTO m FROM billing_accounts WHERE workspace_id=wid;
  RETURN s || jsonb_build_object('mode', m);
END $$;

-- 292's send meter behind the fence.
CREATE OR REPLACE FUNCTION billing_meter_sends() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM billing_meter_fence(w) FROM (SELECT DISTINCT workspace_id AS w FROM new_mail ORDER BY 1) x;
  INSERT INTO billing_usage_hourly AS u (workspace_id,hour,meter,rate_version,quantity)
  SELECT n.workspace_id, date_trunc('hour',now(),'UTC'),
         CASE WHEN (n.feedback_topic_arn IS NULL AND pc.kind='shared')
                OR EXISTS (SELECT FROM provider_pool_regions p WHERE p.feedback_topic_arn=n.feedback_topic_arn)
              THEN 'send' ELSE 'byo_send' END,
         1, sum(jsonb_array_length(n.to_addresses||n.cc_addresses||n.bcc_addresses))
  FROM new_mail n
  CROSS JOIN LATERAL (SELECT kind FROM provider_connections WHERE workspace_id=n.workspace_id ORDER BY kind LIMIT 1) pc
  CROSS JOIN (SELECT bill_simulated FROM billing_config WHERE singleton) cfg
  WHERE (NOT n.simulated OR cfg.bill_simulated) AND hosted_charged(n.status,n.provider_id,n.error_code)
  GROUP BY 1,2,3 ORDER BY 1,2,3
  ON CONFLICT (workspace_id,hour,meter,rate_version) DO UPDATE SET quantity=u.quantity+excluded.quantity;
  RETURN NULL;
END $$;

-- Refunds take free units first. 313 keyed what a refund may give back to its hour's charged units, so a cancellation
-- of mail settled at $0 (exempt, shadow, off) could take the charge of different mail metered in the same hour on the
-- other side of a mode change. Each hour now also records its units settled uncharged; a refund is taken from those
-- first and gives back money only beyond them.
ALTER TABLE billing_usage_paid ADD COLUMN free_units bigint NOT NULL DEFAULT 0 CHECK (free_units >= 0);

-- The position prices this month's open sends and receives against this month's allowances only. Open rows of an
-- earlier month (a late write: a refund or a charge of mail admitted then) were netted into this month's free
-- count, so a past-month refund handed out free sends the settler then charged for. They are priced as the settler
-- prices them, against that month's own settled pool (a refund there counts only once it has settled, as in 313).
-- receiveHold says whether receive holds are on at all, so nothing promises a hold that won't happen.
CREATE OR REPLACE FUNCTION billing_position(wid text) RETURNS jsonb LANGUAGE sql STABLE AS $$
WITH cfg AS (SELECT mode AS enforcement, receive_hold, free_split_from FROM billing_config WHERE singleton),
mon AS (SELECT date_trunc('month', now(), 'UTC') AS start),
a AS (SELECT coalesce(b.mode,'prepaid') AS mode, coalesce(b.balance_uc,0) AS bal, coalesce(b.promo_uc,0) AS promo,
        CASE WHEN b.free_month=(date_trunc('month',now() AT TIME ZONE 'UTC'))::date THEN b.free_sent_used ELSE 0 END AS sent,
        CASE WHEN b.free_month=(date_trunc('month',now() AT TIME ZONE 'UTC'))::date THEN b.free_received_used ELSE 0 END AS received,
        b.unpaid_since, coalesce(b.recharge_threshold_uc,0) AS threshold,
        coalesce(b.recharge_enabled AND b.recharge_disabled_at IS NULL AND b.recharge_pending_attempt IS NULL AND b.stripe_payment_method IS NOT NULL,false) AS can_recharge
      FROM (SELECT 1) one LEFT JOIN billing_accounts b ON b.workspace_id=wid),
-- 313: refunds of other hours' mail give back no allowance or credit until the settler knows what they reverse; this
-- hour's own cancel its unsettled units.
-- 314: as in the settler, the part of an hour's own refunds its units settled uncharged absorb cancels no new units.
u AS (SELECT h.hour, h.meter, h.rate_version, h.quantity-h.settled_quantity AS delta,
             greatest(0, h.quantity-h.settled_quantity-rf.other+least(-rf.own, coalesce(pd.free_units,0))) AS new_units
      FROM billing_usage_hourly h
      CROSS JOIN LATERAL (SELECT coalesce(sum(v::bigint) FILTER (WHERE k<>extract(epoch FROM h.hour)::bigint::text),0) AS other,
                                 coalesce(sum(v::bigint) FILTER (WHERE k=extract(epoch FROM h.hour)::bigint::text),0) AS own
                          FROM jsonb_each_text(h.refunds) x(k,v)) rf
      LEFT JOIN billing_usage_paid pd ON pd.workspace_id=h.workspace_id AND pd.hour=h.hour AND pd.meter=h.meter
      WHERE h.workspace_id=wid AND (h.quantity <> h.settled_quantity OR h.refunds <> '{}')),
o AS (SELECT coalesce(sum(new_units) FILTER (WHERE meter='send' AND hour>=mon.start),0) AS sends,
             coalesce(sum(new_units) FILTER (WHERE meter='receive' AND hour>=mon.start),0) AS receives,
             coalesce(sum(delta*billing_rate_uc(meter,rate_version,hour)) FILTER (WHERE meter IN ('omen','storage')),0) AS other_uc
      FROM u, mon),
past AS (SELECT coalesce(sum(greatest(0, s.before + x.units - 3000) - greatest(0, s.before - 3000)), 0) * 20000 AS uc
      FROM (SELECT date_trunc('month', u.hour, 'UTC') AS m,
                   CASE WHEN date_trunc('month', u.hour, 'UTC') < cfg.free_split_from::timestamp AT TIME ZONE 'UTC' THEN 'both' ELSE u.meter END AS pool,
                   sum(u.new_units) AS units
            FROM u, mon, cfg WHERE u.meter IN ('send','receive') AND u.hour<mon.start GROUP BY 1,2) x
      CROSS JOIN LATERAL (SELECT coalesce(sum(h.settled_quantity),0) AS before FROM billing_usage_hourly h
            WHERE h.workspace_id=wid AND h.hour>=x.m AND h.hour<(x.m AT TIME ZONE 'UTC' + interval '1 month') AT TIME ZONE 'UTC'
              AND (h.meter=x.pool OR (x.pool='both' AND h.meter IN ('send','receive')))) s),
p AS (SELECT a.*, cfg.*,
        round((greatest(0,coalesce(a.sent,0)+o.sends-3000)-greatest(0,coalesce(a.sent,0)-3000)
              +greatest(0,coalesce(a.received,0)+o.receives-3000)-greatest(0,coalesce(a.received,0)-3000))*20000+past.uc+o.other_uc)::bigint AS open_uc,
        least(3000,greatest(0,3000-coalesce(a.sent,0)-o.sends))::int AS sent_left,
        least(3000,greatest(0,3000-coalesce(a.received,0)-o.receives))::int AS received_left FROM a,cfg,o,past)
SELECT jsonb_build_object('mode',mode,'enforcement',enforcement,'balanceUc',bal::text,'promoUc',promo::text,
  'openUc',open_uc::text,'availableUc',(bal+promo-open_uc)::text,'freeSentLeft',sent_left,'freeReceivedLeft',received_left,'freeEmailsLeft',sent_left,
  'unpaidSince',unpaid_since,'receiveHold',receive_hold,
  'receiveHeld', coalesce(enforcement='enforce' AND receive_hold AND mode='prepaid' AND unpaid_since<=now()-interval '7 days',false),
  'omens', mode<>'prepaid' OR enforcement<>'enforce' OR bal+promo-open_uc>0,
  'canRecharge',can_recharge,'thresholdUc',threshold::text) FROM p
$$;

-- Promotional credit spent on usage is tracked per usage month. A refund returns promo only up to what promo paid
-- for that month's usage, and the rest goes back to paid credit. Before, the account-lifetime counter turned the
-- refund of paid usage into promo for as long as any promo had ever been spent. Within one month, promo still
-- comes back first: which units a refund cancels isn't known, and returning paid credit for usage promo paid for
-- would turn promo into refundable cash. promo_spent_uc stays as the lifetime total.
CREATE TABLE billing_promo_spent (
  workspace_id text NOT NULL,
  month date NOT NULL,
  spent_uc bigint NOT NULL CHECK (spent_uc >= 0),
  PRIMARY KEY (workspace_id, month));
-- Billing launched this month, so promo spent so far is this month's; it is also counted for the month before, so a
-- deploy after the month turns can't return paid credit for it.
INSERT INTO billing_promo_spent(workspace_id, month, spent_uc)
  SELECT workspace_id, m, promo_spent_uc FROM billing_accounts
  CROSS JOIN (VALUES ((date_trunc('month', now() AT TIME ZONE 'UTC'))::date), ((date_trunc('month', now() AT TIME ZONE 'UTC') - interval '1 month')::date)) v(m)
  WHERE promo_spent_uc > 0 ORDER BY 1, 2;

-- 313's settler with per-month promo (above) and the sends_paused notice taken from this month's counter only (the
-- settlement just after midnight on the 1st read last month's used-up allowance, sent "sending paused" while
-- this month's free sends were all left, and the episode it opened suppressed the real notice later that month).
CREATE OR REPLACE FUNCTION billing_settle(wid text, cutoff timestamptz) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE a billing_accounts; cfg billing_config; r record; delta bigint; before bigint; after bigint; payable numeric;
  line numeric; spend numeric; det jsonb := '{}'; m jsonb; rmonth date; mon date; sent bigint; received bigint;
  n int := 0; cost_uc bigint; charged boolean; promo_draw bigint := 0; paid_draw bigint := 0; total bigint;
  posted jsonb; first_hour timestamptz; last_hour timestamptz; recharging boolean;
  pending jsonb; own text; refund bigint; fresh bigint; back bigint; take bigint; o record; gone bigint; f bigint; c bigint;
  months jsonb := '{}'; mc record; spent bigint; promo_left bigint;
BEGIN
  INSERT INTO billing_accounts(workspace_id) VALUES (wid) ON CONFLICT DO NOTHING;
  SELECT * INTO a FROM billing_accounts WHERE workspace_id=wid FOR UPDATE SKIP LOCKED;
  IF NOT FOUND THEN RETURN '{"busy":true}'; END IF;
  SELECT * INTO cfg FROM billing_config WHERE singleton;
  charged := cfg.mode='enforce' AND a.mode IN ('prepaid','invoiced');
  mon := a.free_month; sent := a.free_sent_used; received := a.free_received_used; spend := a.month_spend_uc;
  FOR r IN SELECT hour, meter, rate_version, quantity, settled_quantity, refunds FROM billing_usage_hourly
      WHERE workspace_id=wid AND (quantity <> settled_quantity OR refunds <> '{}') AND hour<cutoff ORDER BY hour, meter FOR UPDATE SKIP LOCKED LOOP
    delta := r.quantity - r.settled_quantity;
    rmonth := (date_trunc('month', r.hour AT TIME ZONE 'UTC'))::date;
    IF rmonth > mon THEN mon := rmonth; sent := 0; received := 0; spend := 0; END IF;
    IF r.meter IN ('send','receive') THEN
      IF rmonth < mon OR rmonth < cfg.free_split_from THEN
        SELECT coalesce(sum(settled_quantity),0) INTO before FROM billing_usage_hourly
          WHERE workspace_id=wid AND (meter=r.meter OR (rmonth < cfg.free_split_from AND meter IN ('send','receive')))
            AND hour >= rmonth::timestamp AT TIME ZONE 'UTC' AND hour < (rmonth + interval '1 month')::timestamp AT TIME ZONE 'UTC';
      ELSIF r.meter = 'send' THEN before := sent;
      ELSE before := received; END IF;
      -- fresh: units metered since the last settlement. A negative remainder with no noted origin is this hour's own;
      -- refunds of this hour's own unsettled mail cancel it out before anything is priced.
      own := extract(epoch FROM r.hour)::bigint::text;
      SELECT coalesce(sum(v::bigint), 0) INTO refund FROM jsonb_each_text(r.refunds) x(k, v);
      pending := r.refunds; fresh := delta - refund;
      IF fresh < 0 THEN pending := pending || jsonb_build_object(own, coalesce((pending->>own)::bigint, 0) + fresh); fresh := 0; END IF;
      -- Free first (314): this hour's own refunds are taken from its units already settled uncharged before they cancel
      -- new units. They leave the pool and give nothing back.
      gone := 0;
      take := least(-coalesce((pending->>own)::bigint, 0), coalesce((SELECT free_units FROM billing_usage_paid WHERE workspace_id=wid AND hour=r.hour AND meter=r.meter), 0));
      IF take > 0 THEN
        UPDATE billing_usage_paid SET free_units=free_units-take WHERE workspace_id=wid AND hour=r.hour AND meter=r.meter;
        gone := take; pending := pending || jsonb_build_object(own, (pending->>own)::bigint + take);
      END IF;
      take := least(fresh, -coalesce((pending->>own)::bigint, 0));
      IF take > 0 THEN fresh := fresh - take; pending := pending || jsonb_build_object(own, (pending->>own)::bigint + take); END IF;
      SELECT coalesce(sum(v::bigint), 0) INTO refund FROM jsonb_each_text(pending) x(k, v);
      -- Refunds leave the pool; money comes back only for units their own hours were charged.
      after := greatest(0, before + refund - gone);
      back := 0;
      -- Free first (314): a refund is taken from its hour's units settled uncharged before its charged ones. Which send
      -- of a mixed hour it cancels isn't known, and this way it never gives back another send's charge.
      FOR o IN SELECT to_timestamp(ltrim(k, 's')::bigint) AS origin, -v::bigint AS units FROM jsonb_each_text(pending) x(k, v) WHERE v::bigint < 0 ORDER BY ltrim(k, 's')::bigint LOOP
        f := NULL; c := NULL;
        SELECT free_units, units INTO f, c FROM billing_usage_paid WHERE workspace_id=wid AND hour=o.origin AND meter=r.meter;
        f := least(o.units, coalesce(f, 0)); take := least(o.units - f, coalesce(c, 0));
        IF f > 0 OR take > 0 THEN
          UPDATE billing_usage_paid SET free_units=free_units-f, units=units-take WHERE workspace_id=wid AND hour=o.origin AND meter=r.meter;
          back := back + take;
        END IF;
      END LOOP;
      before := after; after := before + fresh;
      payable := greatest(0, after - 3000) - greatest(0, before - 3000);
      IF charged AND payable > 0 THEN
        INSERT INTO billing_usage_paid AS p VALUES (wid, r.hour, r.meter, payable) ON CONFLICT (workspace_id, hour, meter) DO UPDATE SET units=p.units+excluded.units;
      END IF;
      -- Units settled uncharged (exempt, shadow, off) are this hour's free units: refunds take them first.
      IF NOT charged AND fresh > 0 THEN
        INSERT INTO billing_usage_paid AS p (workspace_id, hour, meter, units, free_units) VALUES (wid, r.hour, r.meter, 0, fresh)
          ON CONFLICT (workspace_id, hour, meter) DO UPDATE SET free_units=p.free_units+excluded.free_units;
      END IF;
      payable := payable - back;
      IF NOT (rmonth < mon OR rmonth < cfg.free_split_from) THEN
        IF r.meter = 'send' THEN sent := after; ELSE received := after; END IF;
      END IF;
      line := payable * 20000;
    ELSIF r.meter = 'omen' THEN payable := delta; line := delta * 10000::numeric;
    ELSIF r.meter = 'storage' THEN payable := delta; line := delta * billing_rate_uc('storage', r.rate_version, r.hour);
    ELSE payable := 0; line := 0; END IF;                  -- byo_*: $0, reported
    months := months || jsonb_build_object(rmonth::text, coalesce((months->>rmonth::text)::numeric, 0) + line);
    IF rmonth >= mon THEN spend := spend + line; END IF;
    m := coalesce(det->r.meter, '{"quantity":0,"payable":0,"costUc":0}'::jsonb);
    det := det || jsonb_build_object(r.meter, jsonb_build_object('quantity', (m->>'quantity')::numeric + delta,
      'payable', (m->>'payable')::numeric + payable, 'costUc', (m->>'costUc')::numeric + line));
    UPDATE billing_usage_hourly SET settled_quantity=r.quantity, refunds='{}'
      WHERE workspace_id=wid AND hour=r.hour AND meter=r.meter AND rate_version=r.rate_version;
    first_hour := least(first_hour, r.hour); last_hour := greatest(last_hour, r.hour); n := n + 1;
  END LOOP;
  IF n = 0 THEN RETURN jsonb_build_object('entries', 0); END IF;
  -- Each usage month's cost is rounded on its own (a settlement within one month rounds as before), so the promo
  -- drawn per month adds up to at most the cost posted.
  SELECT coalesce(sum(round(value::numeric)), 0)::bigint INTO cost_uc FROM jsonb_each_text(months);
  IF charged THEN
    -- Refunds first (each month gives back promo up to what promo paid for that month), then charges (promo first).
    promo_left := a.promo_uc;
    FOR mc IN SELECT key::date AS month, round(value::numeric)::bigint AS uc FROM jsonb_each_text(months) ORDER BY (value::numeric >= 0), key LOOP
      CONTINUE WHEN mc.uc = 0;
      SELECT spent_uc INTO spent FROM billing_promo_spent WHERE workspace_id=wid AND month=mc.month FOR UPDATE;
      take := CASE WHEN mc.uc < 0 THEN -least(coalesce(spent, 0), -mc.uc) ELSE least(promo_left, mc.uc) END;
      CONTINUE WHEN take = 0;
      IF take < 0 THEN UPDATE billing_promo_spent SET spent_uc=spent_uc+take WHERE workspace_id=wid AND month=mc.month;
      ELSE INSERT INTO billing_promo_spent AS p (workspace_id, month, spent_uc) VALUES (wid, mc.month, take)
        ON CONFLICT (workspace_id, month) DO UPDATE SET spent_uc=p.spent_uc+excluded.spent_uc; END IF;
      promo_left := promo_left - take; promo_draw := promo_draw + take;
    END LOOP;
    paid_draw := cost_uc - promo_draw;
  END IF;
  posted := billing_post(wid, 'usage', 'usage:'||wid||':'||txid_current()||':'||extract(epoch FROM clock_timestamp()), -paid_draw, -promo_draw,
    jsonb_build_object('meters', det, 'costUc', cost_uc::text, 'charged', charged, 'from', first_hour, 'to', last_hour + interval '1 hour', 'rateVersion', 1), 'system');
  UPDATE billing_accounts SET free_month=mon, free_sent_used=least(sent, 2147483647)::int, free_received_used=least(received, 2147483647)::int,
      month_spend_uc=round(spend)::bigint, promo_spent_uc=greatest(0, promo_spent_uc+promo_draw), updated_at=now()
    WHERE workspace_id=wid RETURNING * INTO a;
  IF cfg.mode='enforce' AND a.mode='prepaid' THEN
    total := a.balance_uc + a.promo_uc;
    recharging := a.recharge_enabled AND a.recharge_disabled_at IS NULL AND a.stripe_payment_method IS NOT NULL;
    IF total > 0 AND total < a.low_balance_uc AND a.low_since IS NULL AND NOT recharging THEN
      UPDATE billing_accounts SET low_since=now() WHERE workspace_id=wid RETURNING * INTO a;
      PERFORM billing_notice(wid, 'low_balance', 'low_balance:'||wid||':'||a.low_since, jsonb_build_object('totalUc', total::text));
    END IF;
    -- Sending pauses once the balance is gone and this month's free sends are used; free received mail doesn't keep it going.
    IF total <= 0 AND a.free_month=(date_trunc('month', now() AT TIME ZONE 'UTC'))::date AND a.free_sent_used >= 3000 AND a.empty_since IS NULL THEN
      UPDATE billing_accounts SET empty_since=now() WHERE workspace_id=wid RETURNING * INTO a;
      PERFORM billing_notice(wid, 'sends_paused', 'sends_paused:'||wid||':'||a.empty_since,
        jsonb_build_object('totalUc', total::text, 'unpaidSince', a.unpaid_since));
    END IF;
    IF recharging AND a.recharge_pending_attempt IS NULL AND total < a.recharge_threshold_uc THEN
      INSERT INTO jobs(id,type,workspace_id,payload) VALUES ('billing.recharge:'||wid,'billing.recharge',wid,'{}')
        ON CONFLICT (id) DO UPDATE SET status='pending',attempts=0,available_at=now(),lease_until=NULL,last_error=NULL
        WHERE jobs.status IN ('completed','failed');
    END IF;
  END IF;
  RETURN jsonb_build_object('entries', n, 'costUc', cost_uc::text, 'charged', charged, 'entryId', posted->>'entryId');
END $$;

-- 300's billing_post with two changes (a payment, a grant or a credit adjustment still ends an episode; a usage
-- refund doesn't, as in 313):
-- - The unpaid episode follows paid + promotional credit. A promo grant that covers a debt ends the episode (and its
--   receive hold) like a top-up; before, the hold stayed while sends ran on the promo, and survived the write-off.
--   The paid debt itself stays and the next top-up pays it first. A write-off still never ends an episode.
-- - billing.restored is queued again even while a restore runs: that run may have decided before this credit, and
--   skipping the wake left held mail parked until the next credit.
CREATE OR REPLACE FUNCTION billing_post(wid text, k text, src text, paid bigint, promo bigint, det jsonb, who text) RETURNS jsonb
LANGUAGE plpgsql AS $$
DECLARE a billing_accounts; eid bigint;
  credit boolean := k IN ('topup','grant','refund_release','dispute_reversal') OR (k='adjustment' AND paid+promo>0);
BEGIN
  INSERT INTO billing_accounts(workspace_id) VALUES (wid) ON CONFLICT DO NOTHING;
  SELECT * INTO a FROM billing_accounts WHERE workspace_id=wid FOR UPDATE;
  INSERT INTO billing_ledger(workspace_id,kind,source_id,paid_uc,promo_uc,balance_after_uc,promo_after_uc,detail,actor)
    VALUES (wid,k,src,paid,promo,a.balance_uc+paid,a.promo_uc+promo,coalesce(det,'{}'),who)
    ON CONFLICT (kind,source_id) DO NOTHING RETURNING id INTO eid;
  IF eid IS NULL THEN RETURN jsonb_build_object('applied',false,'balanceUc',a.balance_uc::text,'promoUc',a.promo_uc::text); END IF;
  IF a.promo_uc+promo < 0 THEN RAISE EXCEPTION 'promo below zero' USING ERRCODE='23514'; END IF;
  UPDATE billing_accounts SET balance_uc=balance_uc+paid, promo_uc=promo_uc+promo, updated_at=now(),
    unpaid_since = CASE WHEN balance_uc+paid+promo_uc+promo<0 THEN coalesce(unpaid_since,now()) WHEN credit THEN NULL ELSE unpaid_since END,
    empty_since  = CASE WHEN credit AND balance_uc+paid+promo_uc+promo>0 THEN NULL ELSE empty_since END,
    low_since    = CASE WHEN credit AND balance_uc+paid+promo_uc+promo>=low_balance_uc THEN NULL ELSE low_since END,
    recharge_month_total_uc = CASE WHEN det->>'recharge'='true' THEN
      CASE WHEN recharge_month=(date_trunc('month',now() AT TIME ZONE 'UTC'))::date THEN recharge_month_total_uc ELSE 0 END + paid
      ELSE recharge_month_total_uc END,
    recharge_month = CASE WHEN det->>'recharge'='true' THEN (date_trunc('month',now() AT TIME ZONE 'UTC'))::date ELSE recharge_month END
  WHERE workspace_id=wid;
  IF paid<>0 THEN PERFORM billing_lots(wid, k, src, paid, a.balance_uc, coalesce(det,'{}')); END IF;   -- 300: credit lots
  IF credit THEN
    INSERT INTO jobs(id,type,workspace_id,payload) VALUES ('billing.restored:'||wid,'billing.restored',wid,'{}')
      ON CONFLICT (id) DO UPDATE SET status='pending',attempts=0,available_at=now(),lease_until=NULL,last_error=NULL;
  END IF;
  RETURN jsonb_build_object('applied',true,'entryId',eid::text,'balanceUc',(a.balance_uc+paid)::text,'promoUc',(a.promo_uc+promo)::text);
END $$;

-- 300's daily scan with two changes:
-- - The receive-hold notices go out only while receive holds are on: "will be held on <date>" promised a hold that
--   didn't come.
-- - A write-off re-reads the balance under the account lock and writes off only the debt left then. The scan's cursor
--   read it earlier, so a top-up landing meanwhile used to be forgiven (and opened a never-expiring lot).
CREATE OR REPLACE FUNCTION billing_unpaid_scan() RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE cfg billing_config; r record; soon int := 0; held int := 0; written int := 0; bal bigint;
  paying CONSTANT text[] := ARRAY['topup','grant','refund_release','dispute_reversal','adjustment'];
BEGIN
  SELECT * INTO cfg FROM billing_config WHERE singleton;
  FOR r IN SELECT workspace_id, unpaid_since, balance_uc FROM billing_accounts
      WHERE unpaid_since IS NOT NULL AND unpaid_since <= now() - interval '5 days' AND mode='prepaid' ORDER BY unpaid_since LIMIT 5000 LOOP
    IF cfg.mode='enforce' AND cfg.receive_hold THEN
      IF billing_notice(r.workspace_id, 'receive_hold_soon', 'receive_hold_soon:'||r.workspace_id||':'||r.unpaid_since,
          jsonb_build_object('debtUc', (-least(r.balance_uc,0))::text, 'holdAt', r.unpaid_since + interval '7 days')) IS NOT NULL THEN soon := soon + 1; END IF;
      IF r.unpaid_since <= now() - interval '7 days' AND billing_notice(r.workspace_id, 'receive_held', 'receive_held:'||r.workspace_id||':'||r.unpaid_since,
          jsonb_build_object('debtUc', (-least(r.balance_uc,0))::text, 'heldSince', r.unpaid_since + interval '7 days')) IS NOT NULL THEN held := held + 1; END IF;
    END IF;
    IF r.unpaid_since <= now() - interval '60 days' AND r.balance_uc < 0 THEN
      SELECT balance_uc INTO bal FROM billing_accounts WHERE workspace_id=r.workspace_id FOR UPDATE;
      IF bal < 0 AND NOT EXISTS (SELECT FROM billing_ledger l WHERE l.workspace_id=r.workspace_id AND l.created_at > now() - interval '60 days'
          AND l.kind = ANY (paying) AND l.paid_uc + l.promo_uc > 0) THEN
        IF (billing_post(r.workspace_id, 'write_off', 'write_off:'||r.workspace_id||':'||(r.unpaid_since AT TIME ZONE 'UTC')::date||':'||(now() AT TIME ZONE 'UTC')::date,
            -bal, 0, jsonb_build_object('debtUc', (-bal)::text, 'unpaidSince', r.unpaid_since), 'system')->>'applied')::boolean THEN written := written + 1; END IF;
      END IF;
    END IF;
  END LOOP;
  RETURN jsonb_build_object('receiveHoldSoon', soon, 'receiveHeld', held, 'writtenOff', written);
END $$;

-- A send refunded after its workspace deleted its provider connection was dropped (no connection, no meter). A row
-- sent through a pool region's feedback topic was metered as a Hosted send whatever the connection, so it is
-- refunded (or charged) as one; anything else still needs the connection to tell Hosted from BYO.
CREATE OR REPLACE FUNCTION billing_adjust_sends() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE d bigint; m text; h timestamptz; k text;
BEGIN
  IF NEW.simulated AND NOT (SELECT bill_simulated FROM billing_config WHERE singleton) THEN RETURN NULL; END IF;
  d := (hosted_charged(NEW.status,NEW.provider_id,NEW.error_code)::int - hosted_charged(OLD.status,OLD.provider_id,OLD.error_code)::int)
       * jsonb_array_length(NEW.to_addresses||NEW.cc_addresses||NEW.bcc_addresses);
  m := CASE WHEN EXISTS (SELECT FROM provider_pool_regions p WHERE p.feedback_topic_arn=NEW.feedback_topic_arn) THEN 'send'
    ELSE (SELECT CASE WHEN NEW.feedback_topic_arn IS NULL AND kind='shared' THEN 'send' ELSE 'byo_send' END
          FROM provider_connections WHERE workspace_id=NEW.workspace_id ORDER BY kind LIMIT 1) END;
  IF d=0 OR m IS NULL THEN RETURN NULL; END IF;
  PERFORM billing_meter_fence(NEW.workspace_id);
  -- Month arithmetic on UTC wall-clock timestamps: timestamptz + interval '1 month' would follow the session TimeZone.
  h := CASE WHEN date_trunc('month',NEW.created_at,'UTC') < date_trunc('month',now(),'UTC')
         THEN (date_trunc('month',NEW.created_at AT TIME ZONE 'UTC') + interval '1 month' - interval '1 hour') AT TIME ZONE 'UTC'
         ELSE date_trunc('hour',now(),'UTC') END;
  k := CASE WHEN h < date_trunc('hour',now(),'UTC') THEN 's' ELSE '' END || extract(epoch FROM date_trunc('hour', NEW.created_at, 'UTC'))::bigint::text;
  INSERT INTO billing_usage_hourly AS u (workspace_id,hour,meter,rate_version,quantity,settled_quantity,refunds)
    VALUES (NEW.workspace_id,h,m,1,d,0,CASE WHEN d<0 THEN jsonb_build_object(k,d) ELSE '{}' END)
    ON CONFLICT (workspace_id,hour,meter,rate_version) DO UPDATE SET quantity=u.quantity+excluded.quantity,
      refunds=CASE WHEN excluded.quantity<0 THEN u.refunds || jsonb_build_object(k, coalesce((u.refunds->>k)::bigint,0)+excluded.quantity) ELSE u.refunds END;
  RETURN NULL;
END $$;

-- Storage is priced from storage_billing_from at 00:00 UTC. hour < date cast the date in the session time zone,
-- so a session in New York priced the first UTC day at $0.
CREATE OR REPLACE FUNCTION billing_rate_uc(meter text, rate_version smallint, hour timestamptz) RETURNS numeric LANGUAGE sql STABLE AS $$
  SELECT CASE WHEN meter IN ('send','receive') THEN 20000
    WHEN meter='omen' THEN 10000
    WHEN meter='storage' THEN CASE WHEN c.storage_billing_from IS NULL OR hour < c.storage_billing_from::timestamp AT TIME ZONE 'UTC' THEN 0
      ELSE 25000000::numeric / (1e9 * extract(day FROM date_trunc('month', hour AT TIME ZONE 'UTC') + interval '1 month - 1 day')) END
    ELSE 0 END FROM billing_config c WHERE c.singleton
$$;

-- Received-mail meters:
-- - Sandbox mail (POST /v1/inboxes/{id}/simulate stores it with its own ID as the SES message ID, region 'sandbox') is
--   neither a receive nor stored mail: it never arrived, and it used up the free received allowance.
-- - Storage counts what is kept past 90 days. The raw message of default mail expires at 90 days, and ephemeral inbox
--   mail goes within 45, so only kept mail (lifecycle 'kept', whose raw has no expiry) is metered, at its raw size; it
--   was every inbound message's raw size, kept or not. Attachments extracted from default mail outlive its raw and
--   aren't counted: storage never charges for more than is kept.
-- What one message adds to stored bytes. spam, verdicts and region never change after insert; lifecycle can move to
-- kept (billing_restore_mail below follows it).
CREATE FUNCTION billing_stored_bytes(direction text, spam boolean, verdicts jsonb, region text, lifecycle text, size bigint) RETURNS bigint
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT CASE WHEN direction='inbound' AND lifecycle='kept' AND region IS DISTINCT FROM 'sandbox' AND NOT billing_spam_free(spam,verdicts)
    THEN coalesce(size,0) ELSE 0 END
$$;
-- Adds (or takes off) stored bytes of one received day. A day the aged sum already covers (mail released from a
-- billing hold of more than ~90 days keeps its received date) changes the aged sum too, as a delete of it always did.
CREATE FUNCTION billing_store_bytes(wid text, d date, change bigint) RETURNS void LANGUAGE plpgsql AS $$
DECLARE through date := (SELECT storage_aged_through FROM billing_config WHERE singleton);
BEGIN
  IF change = 0 THEN RETURN; END IF;
  INSERT INTO mail_storage_days AS s (workspace_id,day,bytes) VALUES (wid,d,greatest(change,0))
    ON CONFLICT (workspace_id,day) DO UPDATE SET bytes=greatest(0,s.bytes+change);
  IF d <= through THEN
    INSERT INTO mail_storage_aged AS g (workspace_id,aged_bytes,aged_through) VALUES (wid,greatest(change,0),through)
      ON CONFLICT (workspace_id) DO UPDATE SET aged_bytes=greatest(0,g.aged_bytes+change);
  END IF;
END $$;
CREATE OR REPLACE FUNCTION billing_meter_mail() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM billing_meter_fence(w) FROM (SELECT DISTINCT workspace_id AS w FROM new_rows WHERE direction='inbound' ORDER BY 1) x;
  INSERT INTO billing_usage_hourly AS u (workspace_id,hour,meter,rate_version,quantity)
  SELECT n.workspace_id, date_trunc('hour',now(),'UTC'), m.meter, 1, sum(m.q)
  FROM new_rows n
  LEFT JOIN LATERAL (SELECT kind FROM provider_connections WHERE workspace_id=n.workspace_id ORDER BY kind LIMIT 1) pc ON true
  CROSS JOIN LATERAL (VALUES (CASE WHEN pc.kind='byo' THEN 'byo_receive' ELSE 'receive' END, CASE WHEN billing_spam_free(n.spam,n.verdicts) THEN 0 ELSE 1 END::bigint),
                             ('omen', coalesce((n.verdicts->>'omenCalls')::bigint,0))) m(meter,q)
  WHERE n.direction='inbound' AND n.ses_message_id IS NOT NULL AND n.region IS DISTINCT FROM 'sandbox' AND m.q>0
  GROUP BY 1,2,3 ORDER BY 1,2,3
  ON CONFLICT (workspace_id,hour,meter,rate_version) DO UPDATE SET quantity=u.quantity+excluded.quantity;
  PERFORM billing_store_bytes(w, d, b) FROM (
    SELECT workspace_id AS w, (received_at AT TIME ZONE 'UTC')::date AS d, sum(billing_stored_bytes(direction,spam,verdicts,region,lifecycle,size_bytes))::bigint AS b
    FROM new_rows GROUP BY 1,2 ORDER BY 1,2) g WHERE b<>0;
  RETURN NULL;
END $$;
CREATE OR REPLACE FUNCTION billing_unmeter_mail() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM billing_store_bytes(w, d, -b) FROM (
    SELECT workspace_id AS w, (received_at AT TIME ZONE 'UTC')::date AS d, sum(billing_stored_bytes(direction,spam,verdicts,region,lifecycle,size_bytes))::bigint AS b
    FROM old_rows GROUP BY 1,2 ORDER BY 1,2) g WHERE b<>0;
  RETURN NULL;
END $$;
CREATE FUNCTION billing_restore_mail() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM billing_store_bytes(NEW.workspace_id, (NEW.received_at AT TIME ZONE 'UTC')::date,
    billing_stored_bytes(NEW.direction,NEW.spam,NEW.verdicts,NEW.region,NEW.lifecycle,NEW.size_bytes)
    - billing_stored_bytes(OLD.direction,OLD.spam,OLD.verdicts,OLD.region,OLD.lifecycle,OLD.size_bytes));
  RETURN NULL;
END $$;

-- Rebuilds the storage tables under the new rule, keeping the storage cursor: the aged sums are summed again up to the
-- day it reached, so the next daily run meters every day since the last one it metered.
CREATE FUNCTION billing_storage_rebuild() RETURNS void LANGUAGE plpgsql AS $$
DECLARE through date;
BEGIN
  SELECT storage_aged_through INTO through FROM billing_config WHERE singleton FOR UPDATE;
  DELETE FROM mail_storage_aged;
  DELETE FROM mail_storage_days;
  INSERT INTO mail_storage_days AS s (workspace_id,day,bytes)
  SELECT workspace_id, (received_at AT TIME ZONE 'UTC')::date, sum(billing_stored_bytes(direction,spam,verdicts,region,lifecycle,size_bytes))
  FROM mail_messages WHERE direction='inbound' AND lifecycle='kept'
  GROUP BY 1,2 HAVING sum(billing_stored_bytes(direction,spam,verdicts,region,lifecycle,size_bytes)) > 0
  ON CONFLICT (workspace_id,day) DO UPDATE SET bytes=excluded.bytes;
  IF through IS NOT NULL THEN
    INSERT INTO mail_storage_aged (workspace_id, aged_bytes, aged_through)
    SELECT workspace_id, sum(bytes), through FROM mail_storage_days WHERE day <= through GROUP BY 1 ORDER BY 1;
  END IF;
END $$;

-- The storage job meters every day since the last one it metered, each against its own aged sum. It metered only
-- the day it was called for, and its cursor then refused a re-run of a missed day, so that day was never charged.
CREATE OR REPLACE FUNCTION billing_storage_day(d date) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE since date; x date; aged int := 0; metered int := 0; k int;
BEGIN
  SELECT storage_aged_through INTO since FROM billing_config WHERE singleton FOR UPDATE;
  IF since IS NOT NULL AND since >= d - 91 THEN RETURN jsonb_build_object('aged', 0, 'metered', 0, 'through', since); END IF;
  x := CASE WHEN since IS NULL THEN d ELSE since + 92 END;     -- the first day not metered yet
  WHILE x <= d LOOP
    INSERT INTO mail_storage_aged AS a (workspace_id, aged_bytes, aged_through)
      SELECT workspace_id, sum(bytes), x - 91 FROM mail_storage_days
      WHERE day <= x - 91 AND (since IS NULL OR day > since) GROUP BY 1 ORDER BY 1
      ON CONFLICT (workspace_id) DO UPDATE SET aged_bytes=a.aged_bytes+excluded.aged_bytes, aged_through=excluded.aged_through;
    GET DIAGNOSTICS k = ROW_COUNT; aged := aged + k;
    UPDATE mail_storage_aged SET aged_through=x - 91 WHERE aged_through<x - 91;
    -- billing_store_bytes reads the cursor: keep it in step with the sums.
    UPDATE billing_config SET storage_aged_through=x - 91, updated_at=now() WHERE singleton;
    PERFORM billing_meter_fence(workspace_id) FROM mail_storage_aged WHERE aged_bytes > 1000000000 ORDER BY workspace_id;
    INSERT INTO billing_usage_hourly (workspace_id, hour, meter, rate_version, quantity)
      SELECT workspace_id, x::timestamp AT TIME ZONE 'UTC', 'storage', 1, aged_bytes - 1000000000
      FROM mail_storage_aged WHERE aged_bytes > 1000000000 ORDER BY workspace_id
      ON CONFLICT DO NOTHING;
    GET DIAGNOSTICS k = ROW_COUNT; metered := metered + k;
    since := x - 91; x := x + 1;
  END LOOP;
  RETURN jsonb_build_object('aged', aged, 'metered', metered, 'through', since);
END $$;

-- Unpaid episodes the old rule kept open on a debt that paid plus promotional credit covers (a promo grant to a
-- workspace in debt) end now, as billing_post would end them, and held mail is released. Replays each unpaid
-- account's ledger under the new rule: an episode starts when paid + promo goes below $0 and ends on a credit that
-- leaves it at $0 or more. A write-off still ends nothing, so its hold stays. Only clears; returns the workspaces.
CREATE FUNCTION billing_reconcile_unpaid() RETURNS text[] LANGUAGE plpgsql AS $$
DECLARE w record; l record; st timestamptz; done text[] := '{}';
BEGIN
  FOR w IN SELECT workspace_id FROM billing_accounts WHERE unpaid_since IS NOT NULL ORDER BY workspace_id FOR UPDATE LOOP
    st := NULL;
    FOR l IN SELECT kind, paid_uc + promo_uc AS amount, balance_after_uc + promo_after_uc AS total, created_at
        FROM billing_ledger WHERE workspace_id=w.workspace_id ORDER BY id LOOP
      IF l.total < 0 THEN st := coalesce(st, l.created_at);
      ELSIF l.kind IN ('topup','grant','refund_release','dispute_reversal') OR (l.kind='adjustment' AND l.amount > 0) THEN st := NULL; END IF;
    END LOOP;
    CONTINUE WHEN st IS NOT NULL;
    UPDATE billing_accounts SET unpaid_since=NULL, updated_at=now() WHERE workspace_id=w.workspace_id;
    INSERT INTO jobs(id,type,workspace_id,payload) VALUES ('billing.restored:'||w.workspace_id,'billing.restored',w.workspace_id,'{}')
      ON CONFLICT (id) DO UPDATE SET status='pending',attempts=0,available_at=now(),lease_until=NULL,last_error=NULL;
    done := done || w.workspace_id;
  END LOOP;
  RETURN done;
END $$;

SELECT billing_storage_rebuild();
SELECT billing_reconcile_unpaid();

-- Last, so its lock on mail_messages is held only until this migration commits.
CREATE TRIGGER billing_restore_mail AFTER UPDATE OF lifecycle ON mail_messages FOR EACH ROW
  WHEN (OLD.lifecycle IS DISTINCT FROM NEW.lifecycle AND NEW.direction='inbound') EXECUTE FUNCTION billing_restore_mail();
