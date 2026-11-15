SET LOCAL lock_timeout='2s';
-- The free tier is 3,000 sent and 3,000 received emails each UTC month, counted separately (Ryan, 2026-11-15); it was
-- 3,000 sent and received combined. Each direction has its own allowance: sends beyond 3,000 are charged even while
-- received mail is still free, and the other way round. The rate stays $0.20 per 1,000 for each.
--
-- The new rule applies to the whole month this ships in: billing_free_split returns what this month already paid under
-- the combined rule beyond what the split rule charges, so no workspace pays more this month than either rule asks.
-- Months before it keep the combined pool for late writes (a refund of mail admitted then).
ALTER TABLE billing_accounts ADD COLUMN free_sent_used integer NOT NULL DEFAULT 0,       -- settled send units in free_month
  ADD COLUMN free_received_used integer NOT NULL DEFAULT 0;                               -- settled receive units in free_month
ALTER TABLE billing_config ADD COLUMN free_split_from date;                              -- first month priced per direction
UPDATE billing_config SET free_split_from=(date_trunc('month', now() AT TIME ZONE 'UTC'))::date WHERE singleton;

-- 293's position with one allowance per direction. freeEmailsLeft repeats freeSentLeft for Workers deployed before
-- this migration (sending gates read it) and can go once every Worker reads freeSentLeft.
CREATE OR REPLACE FUNCTION billing_position(wid text) RETURNS jsonb LANGUAGE sql STABLE AS $$
WITH cfg AS (SELECT mode AS enforcement, receive_hold FROM billing_config WHERE singleton),
a AS (SELECT coalesce(b.mode,'prepaid') AS mode, coalesce(b.balance_uc,0) AS bal, coalesce(b.promo_uc,0) AS promo,
        CASE WHEN b.free_month=(date_trunc('month',now() AT TIME ZONE 'UTC'))::date THEN b.free_sent_used ELSE 0 END AS sent,
        CASE WHEN b.free_month=(date_trunc('month',now() AT TIME ZONE 'UTC'))::date THEN b.free_received_used ELSE 0 END AS received,
        b.unpaid_since, coalesce(b.recharge_threshold_uc,0) AS threshold,
        coalesce(b.recharge_enabled AND b.recharge_disabled_at IS NULL AND b.recharge_pending_attempt IS NULL AND b.stripe_payment_method IS NOT NULL,false) AS can_recharge
      FROM (SELECT 1) one LEFT JOIN billing_accounts b ON b.workspace_id=wid),
o AS (SELECT coalesce(sum(quantity-settled_quantity) FILTER (WHERE meter='send'),0) AS sends,
             coalesce(sum(quantity-settled_quantity) FILTER (WHERE meter='receive'),0) AS receives,
             coalesce(sum((quantity-settled_quantity)*billing_rate_uc(meter,rate_version,hour)) FILTER (WHERE meter IN ('omen','storage')),0) AS other_uc
      FROM billing_usage_hourly WHERE workspace_id=wid AND quantity<>settled_quantity),
p AS (SELECT a.*, cfg.*,
        round((greatest(0,coalesce(a.sent,0)+o.sends-3000)-greatest(0,coalesce(a.sent,0)-3000)
              +greatest(0,coalesce(a.received,0)+o.receives-3000)-greatest(0,coalesce(a.received,0)-3000))*20000+o.other_uc)::bigint AS open_uc,
        least(3000,greatest(0,3000-coalesce(a.sent,0)-o.sends))::int AS sent_left,
        least(3000,greatest(0,3000-coalesce(a.received,0)-o.receives))::int AS received_left FROM a,cfg,o)
SELECT jsonb_build_object('mode',mode,'enforcement',enforcement,'balanceUc',bal::text,'promoUc',promo::text,
  'openUc',open_uc::text,'availableUc',(bal+promo-open_uc)::text,'freeSentLeft',sent_left,'freeReceivedLeft',received_left,'freeEmailsLeft',sent_left,
  'unpaidSince',unpaid_since,
  'receiveHeld', coalesce(enforcement='enforce' AND receive_hold AND mode='prepaid' AND unpaid_since<=now()-interval '7 days',false),
  'omens', mode<>'prepaid' OR enforcement<>'enforce' OR bal+promo-open_uc>0,
  'canRecharge',can_recharge,'thresholdUc',threshold::text) FROM p
$$;

-- The gate prices sends only, against the sent allowance: a workspace with free received mail left still pays per send.
CREATE OR REPLACE FUNCTION billing_gate(wid text, emails int, sim boolean DEFAULT false) RETURNS jsonb LANGUAGE plpgsql VOLATILE AS $$
DECLARE p jsonb := billing_position(wid); avail bigint; charge bigint; ok boolean;
BEGIN
  IF sim AND NOT (SELECT bill_simulated FROM billing_config WHERE singleton) THEN emails := 0; END IF;
  avail := (p->>'availableUc')::bigint;
  charge := 20000::bigint * greatest(0, emails - (p->>'freeSentLeft')::int);
  ok := p->>'mode'<>'prepaid' OR avail-charge >= 0;           -- debt blocks even free sends
  IF p->>'enforcement'='enforce' AND p->>'mode'='prepaid' AND (p->>'canRecharge')::boolean AND avail-charge < (p->>'thresholdUc')::bigint THEN
    INSERT INTO jobs(id,type,workspace_id,payload) VALUES ('billing.recharge:'||wid,'billing.recharge',wid,'{}')
      ON CONFLICT (id) DO UPDATE SET status='pending',attempts=0,available_at=now(),lease_until=NULL,last_error=NULL
      WHERE jobs.status IN ('completed','failed');
  END IF;
  RETURN p || jsonb_build_object('ok',ok,'enforced',p->>'enforcement'='enforce' AND p->>'mode'='prepaid','requiredUc',charge::text);
END $$;

-- 300's settler with a free pool per direction. A late write into a past month is priced against that month's own
-- pool: its settled units of the same meter, or of both meters for a month before free_split_from.
CREATE OR REPLACE FUNCTION billing_settle(wid text, cutoff timestamptz) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE a billing_accounts; cfg billing_config; r record; delta bigint; before bigint; after bigint; payable numeric;
  line numeric; cost numeric := 0; spend numeric; det jsonb := '{}'; m jsonb; rmonth date; mon date; sent bigint; received bigint;
  n int := 0; cost_uc bigint; charged boolean; promo_draw bigint := 0; paid_draw bigint := 0; total bigint;
  posted jsonb; first_hour timestamptz; last_hour timestamptz; recharging boolean;
BEGIN
  INSERT INTO billing_accounts(workspace_id) VALUES (wid) ON CONFLICT DO NOTHING;
  SELECT * INTO a FROM billing_accounts WHERE workspace_id=wid FOR UPDATE SKIP LOCKED;
  IF NOT FOUND THEN RETURN '{"busy":true}'; END IF;
  SELECT * INTO cfg FROM billing_config WHERE singleton;
  mon := a.free_month; sent := a.free_sent_used; received := a.free_received_used; spend := a.month_spend_uc;
  FOR r IN SELECT hour, meter, rate_version, quantity, settled_quantity FROM billing_usage_hourly
      WHERE workspace_id=wid AND quantity<>settled_quantity AND hour<cutoff ORDER BY hour, meter FOR UPDATE SKIP LOCKED LOOP
    delta := r.quantity - r.settled_quantity;
    rmonth := (date_trunc('month', r.hour AT TIME ZONE 'UTC'))::date;
    IF rmonth > mon THEN mon := rmonth; sent := 0; received := 0; spend := 0; END IF;
    IF r.meter IN ('send','receive') THEN
      IF rmonth < mon THEN
        SELECT coalesce(sum(settled_quantity),0) INTO before FROM billing_usage_hourly
          WHERE workspace_id=wid AND (meter=r.meter OR (rmonth < cfg.free_split_from AND meter IN ('send','receive')))
            AND hour >= rmonth::timestamp AT TIME ZONE 'UTC' AND hour < (rmonth + interval '1 month')::timestamp AT TIME ZONE 'UTC';
        after := greatest(0, before + delta);
      ELSIF r.meter = 'send' THEN before := sent; after := greatest(0, before + delta); sent := after;
      ELSE before := received; after := greatest(0, before + delta); received := after; END IF;
      payable := greatest(0, after - 3000) - greatest(0, before - 3000);
      line := payable * 20000;
    ELSIF r.meter = 'omen' THEN payable := delta; line := delta * 10000::numeric;
    ELSIF r.meter = 'storage' THEN payable := delta; line := delta * billing_rate_uc('storage', r.rate_version, r.hour);
    ELSE payable := 0; line := 0; END IF;                  -- byo_*: $0, reported
    cost := cost + line;
    IF rmonth >= mon THEN spend := spend + line; END IF;
    m := coalesce(det->r.meter, '{"quantity":0,"payable":0,"costUc":0}'::jsonb);
    det := det || jsonb_build_object(r.meter, jsonb_build_object('quantity', (m->>'quantity')::numeric + delta,
      'payable', (m->>'payable')::numeric + payable, 'costUc', (m->>'costUc')::numeric + line));
    UPDATE billing_usage_hourly SET settled_quantity=r.quantity
      WHERE workspace_id=wid AND hour=r.hour AND meter=r.meter AND rate_version=r.rate_version;
    first_hour := least(first_hour, r.hour); last_hour := greatest(last_hour, r.hour); n := n + 1;
  END LOOP;
  IF n = 0 THEN RETURN jsonb_build_object('entries', 0); END IF;
  cost_uc := round(cost);
  charged := cfg.mode='enforce' AND a.mode IN ('prepaid','invoiced');
  IF charged THEN
    IF cost_uc >= 0 THEN promo_draw := least(a.promo_uc, cost_uc);
    ELSE promo_draw := -least(a.promo_spent_uc, -cost_uc); END IF;   -- a refund returns promo first, up to what it paid
    paid_draw := cost_uc - promo_draw;
  END IF;
  posted := billing_post(wid, 'usage', 'usage:'||wid||':'||txid_current()||':'||extract(epoch FROM clock_timestamp()), -paid_draw, -promo_draw,
    jsonb_build_object('meters', det, 'costUc', cost_uc::text, 'charged', charged, 'from', first_hour, 'to', last_hour + interval '1 hour', 'rateVersion', 1), 'system');
  UPDATE billing_accounts SET free_month=mon, free_sent_used=least(sent, 2147483647)::int, free_received_used=least(received, 2147483647)::int,
      month_spend_uc=round(spend)::bigint, promo_spent_uc=promo_spent_uc+promo_draw, updated_at=now()
    WHERE workspace_id=wid RETURNING * INTO a;
  IF cfg.mode='enforce' AND a.mode='prepaid' THEN
    total := a.balance_uc + a.promo_uc;
    recharging := a.recharge_enabled AND a.recharge_disabled_at IS NULL AND a.stripe_payment_method IS NOT NULL;
    IF total > 0 AND total < a.low_balance_uc AND a.low_since IS NULL AND NOT recharging THEN
      UPDATE billing_accounts SET low_since=now() WHERE workspace_id=wid RETURNING * INTO a;
      PERFORM billing_notice(wid, 'low_balance', 'low_balance:'||wid||':'||a.low_since, jsonb_build_object('totalUc', total::text));
    END IF;
    -- Sending pauses once the balance is gone and the free sends are used; free received mail doesn't keep it going.
    IF total <= 0 AND a.free_sent_used >= 3000 AND a.empty_since IS NULL THEN
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

-- The switch for one account in the month it ships: the per-direction counters from this month's settled usage, and a
-- credit for what the combined rule charged beyond the split rule (combined: the account's settled send + receive units
-- this month). The credit is never negative, never more than this month's usage took from the balance, and posted once
-- (its ledger key), the way the settler posts a refund: promo first, up to what promo paid; shadow and exempt post $0.
CREATE FUNCTION billing_free_split(wid text, combined bigint) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE a billing_accounts; cfg billing_config; mon date := (date_trunc('month', now() AT TIME ZONE 'UTC'))::date;
  sent bigint; received bigint; units bigint; cost bigint; taken bigint; back bigint := 0; promo_back bigint := 0; charged boolean; posted jsonb;
BEGIN
  SELECT * INTO a FROM billing_accounts WHERE workspace_id=wid FOR UPDATE;
  IF NOT FOUND OR a.free_month <> mon THEN RETURN jsonb_build_object('creditUc', '0'); END IF;
  SELECT * INTO cfg FROM billing_config WHERE singleton;
  SELECT greatest(0, coalesce(sum(settled_quantity) FILTER (WHERE meter='send'),0)), greatest(0, coalesce(sum(settled_quantity) FILTER (WHERE meter='receive'),0))
    INTO sent, received FROM billing_usage_hourly
    WHERE workspace_id=wid AND meter IN ('send','receive') AND hour >= mon::timestamp AT TIME ZONE 'UTC' AND hour < (mon + interval '1 month')::timestamp AT TIME ZONE 'UTC';
  UPDATE billing_accounts SET free_sent_used=least(sent, 2147483647)::int, free_received_used=least(received, 2147483647)::int, updated_at=now() WHERE workspace_id=wid;
  units := greatest(0, greatest(0, combined - 3000) - greatest(0, sent - 3000) - greatest(0, received - 3000));
  IF units = 0 THEN RETURN jsonb_build_object('creditUc', '0', 'sent', sent, 'received', received); END IF;
  cost := units * 20000;
  charged := cfg.mode='enforce' AND a.mode IN ('prepaid','invoiced');
  IF charged THEN
    SELECT coalesce(sum(-(paid_uc + promo_uc)),0) INTO taken FROM billing_ledger
      WHERE workspace_id=wid AND kind='usage' AND created_at >= mon::timestamp AT TIME ZONE 'UTC';
    back := least(cost, greatest(0, taken));
    promo_back := least(a.promo_spent_uc, back);
  END IF;
  posted := billing_post(wid, 'usage', 'usage:free-split:'||wid||':'||mon, back - promo_back, promo_back,
    jsonb_build_object('freeSplit', jsonb_build_object('sent', sent, 'received', received, 'combined', combined, 'units', units),
      'costUc', (-cost)::text, 'charged', charged, 'month', mon), 'system');
  IF NOT (posted->>'applied')::boolean THEN RETURN jsonb_build_object('creditUc', '0', 'sent', sent, 'received', received); END IF;
  UPDATE billing_accounts SET month_spend_uc=greatest(0, month_spend_uc - cost), promo_spent_uc=promo_spent_uc - promo_back, updated_at=now() WHERE workspace_id=wid;
  RETURN jsonb_build_object('creditUc', back::text, 'costUc', (-cost)::text, 'sent', sent, 'received', received, 'charged', charged);
END $$;

SELECT billing_free_split(workspace_id, free_emails_used) FROM billing_accounts
  WHERE free_month=(date_trunc('month', now() AT TIME ZONE 'UTC'))::date ORDER BY workspace_id;
ALTER TABLE billing_accounts DROP COLUMN free_emails_used;
