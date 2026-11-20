SET LOCAL lock_timeout='2s';
-- Rate version 2: 5,000 sent and 5,000 received emails free each UTC month, counted separately (Ryan, 2026-11-20). Rate
-- version 1 gave 3,000 and 3,000. The price beyond them stays $0.20 per 1,000, and AI decisions and storage are unchanged.
--
-- A rate version prices whole UTC months: the free allowance is a month's, so one month can't have two. Version 2 prices
-- November 2026, the month this ships in, and every month after it. Earlier months keep version 1, so a late write into
-- one (a refund of mail sent then) is still priced against the 3,000 that month was charged under: no past month is
-- charged again or repriced. billing_usage_hourly.rate_version stays 1: it selects an hour's unit prices
-- (billing_rate_uc), and those haven't changed.
--
-- Usage settled so far this month was priced under version 1. Each month from November 2026 that posted more than it
-- costs under version 2 is posted once here at its new cost: the difference comes back to the balance as a usage row for
-- that month, promotional credit first up to what promo paid for it, as a refund gives it back. A workspace charged for
-- its 3,001st to 5,000th send or received message this month gets that back now, not only at its next settlement.
--
-- lock order: begin
-- billing_accounts (EXCLUSIVE), then what a settlement takes after an account (the ledger, credit lots). It waits for
-- every settlement and money post in flight and holds new ones until it commits, so each month it posts is read after its
-- last settlement under version 1. Meter writes and plain reads (the position, the gate, the dashboard) go on. A
-- settlement that was waiting resumes in its old code and fails on the dropped billing_month_cost(bigint, bigint,
-- numeric); the next run settles that usage.
-- lock order: end
LOCK TABLE billing_accounts IN EXCLUSIVE MODE;

-- Each month's rates, by the month (UTC) usage was metered in. A new version starts with a month, never in one a version
-- has already priced.
DO $$ BEGIN
  IF to_regtype('billing_rates') IS NULL THEN CREATE TYPE billing_rates AS (version smallint, free_sent integer, free_received integer); END IF;
END $$;
CREATE OR REPLACE FUNCTION billing_rates_in(month date) RETURNS billing_rates LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT CASE WHEN month >= DATE '2026-11-01' THEN ROW(2, 5000, 5000)::billing_rates ELSE ROW(1, 3000, 3000)::billing_rates END
$$;

-- A month's cost from its charged totals, at that month's rates.
DROP FUNCTION IF EXISTS billing_month_cost(bigint, bigint, numeric);
CREATE OR REPLACE FUNCTION billing_month_cost(month date, sent bigint, received bigint, other_uc numeric) RETURNS bigint LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT round(20000::numeric * (greatest(0, sent - r.free_sent) + greatest(0, received - r.free_received)) + other_uc)::bigint FROM billing_rates_in(month) r
$$;

-- 333's billing_priced, settlement and position, each month at its own rates.
CREATE OR REPLACE FUNCTION billing_priced(wid text, counted billing_counted[]) RETURNS TABLE (month date, charged boolean,
  sent bigint, received bigint, other_uc numeric, uncharged_sent bigint, uncharged_received bigint, uncharged_other_uc numeric,
  cost_uc bigint, would_be_uc bigint, prior_would_be_uc bigint, posted_uc bigint, promo_uc bigint) LANGUAGE sql STABLE AS $$
  WITH g AS (SELECT (date_trunc('month', x.hour AT TIME ZONE 'UTC'))::date AS month, bool_or(x.charged) AS c,
          coalesce(sum(x.units) FILTER (WHERE x.charged AND x.meter = 'send'), 0)::bigint AS s, coalesce(sum(x.units) FILTER (WHERE x.charged AND x.meter = 'receive'), 0)::bigint AS r,
          coalesce(sum(x.uc) FILTER (WHERE x.charged), 0) AS u,
          coalesce(sum(x.units) FILTER (WHERE NOT x.charged AND x.meter = 'send'), 0)::bigint AS us, coalesce(sum(x.units) FILTER (WHERE NOT x.charged AND x.meter = 'receive'), 0)::bigint AS ur,
          coalesce(sum(x.uc) FILTER (WHERE NOT x.charged), 0) AS uu
        FROM unnest(counted) x GROUP BY 1),
  t AS (SELECT g.month, g.c, coalesce(b.sent, 0) + g.s AS s, coalesce(b.received, 0) + g.r AS r, coalesce(b.other_uc, 0) + g.u AS u,
          coalesce(b.uncharged_sent, 0) + g.us AS us, coalesce(b.uncharged_received, 0) + g.ur AS ur, coalesce(b.uncharged_other_uc, 0) + g.uu AS uu,
          coalesce(b.sent + b.uncharged_sent, 0) AS ps, coalesce(b.received + b.uncharged_received, 0) AS pr, coalesce(b.other_uc + b.uncharged_other_uc, 0) AS pu,
          coalesce(b.posted_uc, 0) AS posted, coalesce(b.promo_uc, 0) AS promo
        FROM g LEFT JOIN billing_months b ON b.workspace_id = wid AND b.month = g.month)
  SELECT month, c, s, r, u, us, ur, uu, billing_month_cost(month, s, r, u), billing_month_cost(month, s + us, r + ur, u + uu), billing_month_cost(month, ps, pr, pu), posted, promo FROM t
$$;

CREATE OR REPLACE FUNCTION billing_settle(wid text, cutoff timestamptz) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE a billing_accounts; cfg billing_config; cut timestamptz := least(cutoff, date_trunc('hour', now(), 'UTC'));
  deltas billing_delta[]; counted billing_counted[]; n_rows int; p record; money bigint; take bigint; promo_left bigint; total bigint; recharging boolean;
  det jsonb; posted jsonb; ids text[] := '{}'; charged_any boolean := false; money_total bigint := 0; would_be_total bigint := 0;
  this_month date := (date_trunc('month', now() AT TIME ZONE 'UTC'))::date; mine billing_months; rates billing_rates;
BEGIN
  INSERT INTO billing_accounts(workspace_id) VALUES (wid) ON CONFLICT DO NOTHING;
  SELECT * INTO a FROM billing_accounts WHERE workspace_id=wid FOR UPDATE SKIP LOCKED;
  IF NOT FOUND THEN RETURN '{"busy":true}'; END IF;
  SELECT * INTO cfg FROM billing_config WHERE singleton;
  WITH open AS (SELECT hour, meter, rate_version, quantity, settled_quantity, refunds FROM billing_usage_hourly
      WHERE workspace_id=wid AND (quantity <> settled_quantity OR refunds <> '{}') AND hour < cutoff
        AND (hour < cut OR EXISTS (SELECT FROM jsonb_object_keys(refunds) k WHERE to_timestamp(ltrim(k, 's')::bigint) < cut))
      ORDER BY hour, meter, rate_version FOR UPDATE SKIP LOCKED),
    part AS (SELECT o.*, CASE WHEN o.hour < cut THEN o.refunds ELSE (SELECT jsonb_object_agg(k, v) FROM jsonb_each(o.refunds) x(k, v)
               WHERE to_timestamp(ltrim(k, 's')::bigint) < cut) END AS taken FROM open o),
    closed AS (UPDATE billing_usage_hourly u
      SET settled_quantity = CASE WHEN r.hour < cut THEN r.quantity ELSE r.settled_quantity + (SELECT sum(v::bigint) FROM jsonb_each_text(r.taken) x(k, v)) END,
          refunds = CASE WHEN r.hour < cut THEN '{}' ELSE r.refunds - ARRAY(SELECT jsonb_object_keys(r.taken)) END
      FROM part r WHERE u.workspace_id=wid AND u.hour=r.hour AND u.meter=r.meter AND u.rate_version=r.rate_version
      RETURNING r.hour, r.meter, r.rate_version, u.settled_quantity - r.settled_quantity AS delta, r.taken)
  SELECT count(DISTINCT (c.hour, c.meter, c.rate_version))::int, array_agg(d ORDER BY d.hour, d.meter) INTO n_rows, deltas
    FROM closed c CROSS JOIN LATERAL billing_row_deltas(c.hour, c.meter, c.rate_version, c.delta, c.taken) d;
  IF coalesce(n_rows, 0) = 0 THEN RETURN jsonb_build_object('entries', 0); END IF;
  counted := ARRAY(SELECT x FROM billing_classify(wid, deltas, NOT (cfg.mode = 'enforce' AND a.mode = 'prepaid')) x);
  -- Forgiven units: added, or taken by refunds (never more than are there). Only the settler writes them, under the
  -- account's lock.
  WITH ch AS (SELECT x.hour, x.meter, sum(x.forgive)::bigint AS d FROM unnest(counted) x WHERE x.forgive <> 0 GROUP BY 1, 2),
  up AS (UPDATE billing_forgiven f SET units = f.units + ch.d FROM ch WHERE f.workspace_id = wid AND f.hour = ch.hour AND f.meter = ch.meter RETURNING f.hour, f.meter)
  INSERT INTO billing_forgiven (workspace_id, hour, meter, units)
    SELECT wid, ch.hour, ch.meter, ch.d FROM ch WHERE NOT EXISTS (SELECT FROM up WHERE up.hour = ch.hour AND up.meter = ch.meter) ORDER BY 2, 3;
  promo_left := a.promo_uc;
  FOR p IN SELECT * FROM billing_priced(wid, counted) ORDER BY cost_uc - posted_uc >= 0, month LOOP
    money := p.cost_uc - p.posted_uc; rates := billing_rates_in(p.month);
    take := CASE WHEN money < 0 THEN -least(p.promo_uc, -money) ELSE least(promo_left, money) END;
    promo_left := promo_left - take;
    -- Per meter: units settled, units beyond the allowance (or charged, for Omens and storage) and their cost; for a
    -- month not charged, what they would have cost.
    WITH d AS (SELECT x.* FROM unnest(counted) x WHERE (date_trunc('month', x.hour AT TIME ZONE 'UTC'))::date = p.month),
    m AS (SELECT d.meter, sum(d.units)::bigint AS q, coalesce(sum(d.units) FILTER (WHERE d.charged OR NOT p.charged), 0)::bigint AS counted,
            coalesce(sum(d.uc) FILTER (WHERE d.charged OR NOT p.charged), 0) AS rated, min(d.hour) AS first, max(d.hour) AS last FROM d GROUP BY d.meter),
    v AS (SELECT m.*, CASE WHEN m.meter IN ('send', 'receive') THEN greatest(0, n - f) - greatest(0, n - m.counted - f)
                           WHEN m.meter IN ('omen', 'storage') THEN m.counted ELSE 0 END AS payable
          FROM m CROSS JOIN LATERAL (SELECT CASE m.meter WHEN 'send' THEN p.sent + CASE WHEN p.charged THEN 0 ELSE p.uncharged_sent END
            WHEN 'receive' THEN p.received + CASE WHEN p.charged THEN 0 ELSE p.uncharged_received END END AS n,
            CASE m.meter WHEN 'send' THEN rates.free_sent WHEN 'receive' THEN rates.free_received END AS f) t)
    SELECT jsonb_build_object('meters', jsonb_object_agg(v.meter, jsonb_build_object('quantity', v.q, 'payable', v.payable,
        'costUc', CASE WHEN v.meter IN ('send', 'receive') THEN v.payable * 20000 WHEN v.meter IN ('omen', 'storage') THEN v.rated ELSE 0 END)),
      'costUc', (CASE WHEN p.charged THEN money ELSE p.would_be_uc - p.prior_would_be_uc END)::text, 'charged', p.charged,
      'from', min(v.first), 'to', max(v.last) + interval '1 hour', 'usageMonth', to_char(p.month, 'YYYY-MM'), 'rateVersion', rates.version) INTO det FROM v;
    posted := billing_post(wid, 'usage', 'usage:'||wid||':'||to_char(p.month, 'YYYY-MM')||':'||txid_current()||':'||extract(epoch FROM clock_timestamp()),
      -(money - take), -take, det, 'system');
    INSERT INTO billing_months AS b (workspace_id, month, sent, received, other_uc, uncharged_sent, uncharged_received, uncharged_other_uc, posted_uc, promo_uc)
      VALUES (wid, p.month, p.sent, p.received, p.other_uc, p.uncharged_sent, p.uncharged_received, p.uncharged_other_uc, p.cost_uc, p.promo_uc + take)
      ON CONFLICT (workspace_id, month) DO UPDATE SET sent=excluded.sent, received=excluded.received, other_uc=excluded.other_uc,
        uncharged_sent=excluded.uncharged_sent, uncharged_received=excluded.uncharged_received, uncharged_other_uc=excluded.uncharged_other_uc,
        posted_uc=excluded.posted_uc, promo_uc=excluded.promo_uc;
    ids := ids || (posted->>'entryId');
    charged_any := charged_any OR p.charged; money_total := money_total + money; would_be_total := would_be_total + p.would_be_uc - p.prior_would_be_uc;
  END LOOP;
  -- The account's month counters of the settler before this one, kept for what still reads them (a Worker of the
  -- previous release during a deploy, an operator's view of the account): this month's charged units and what its
  -- settled usage is worth.
  SELECT * INTO mine FROM billing_months WHERE workspace_id=wid AND month=this_month;
  UPDATE billing_accounts SET free_month=this_month, free_sent_used=least(coalesce(mine.sent, 0), 2147483647)::int,
      free_received_used=least(coalesce(mine.received, 0), 2147483647)::int,
      month_spend_uc=coalesce(billing_month_cost(this_month, mine.sent + mine.uncharged_sent, mine.received + mine.uncharged_received, mine.other_uc + mine.uncharged_other_uc), 0)
    WHERE workspace_id=wid RETURNING * INTO a;
  -- Notices and auto-recharge, as before, for real money only: enforce, prepaid.
  IF cfg.mode='enforce' AND a.mode='prepaid' THEN
    total := a.balance_uc + a.promo_uc;
    recharging := a.recharge_enabled AND a.recharge_disabled_at IS NULL AND a.stripe_payment_method IS NOT NULL;
    IF total > 0 AND total < a.low_balance_uc AND a.low_since IS NULL AND NOT recharging THEN
      UPDATE billing_accounts SET low_since=now() WHERE workspace_id=wid RETURNING * INTO a;
      PERFORM billing_notice(wid, 'low_balance', 'low_balance:'||wid||':'||a.low_since, jsonb_build_object('totalUc', total::text));
    END IF;
    -- Sending pauses once the balance is gone and this month's free sends are used; free received mail doesn't keep it going.
    IF total <= 0 AND coalesce(mine.sent, 0) >= (billing_rates_in(this_month)).free_sent AND a.empty_since IS NULL THEN
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
  RETURN jsonb_build_object('entries', n_rows, 'costUc', (CASE WHEN charged_any THEN money_total ELSE would_be_total END)::text,
    'charged', charged_any, 'entryId', ids[1], 'entryIds', to_jsonb(ids));
END $$;

CREATE OR REPLACE FUNCTION billing_position(wid text) RETURNS jsonb LANGUAGE sql STABLE AS $$
WITH cfg AS (SELECT mode AS enforcement, receive_hold FROM billing_config WHERE singleton),
a AS (SELECT coalesce(b.mode,'prepaid') AS mode, coalesce(b.balance_uc,0) AS bal, coalesce(b.promo_uc,0) AS promo,
        b.unpaid_since, coalesce(b.recharge_threshold_uc,0) AS threshold,
        coalesce(b.recharge_enabled AND b.recharge_disabled_at IS NULL AND b.recharge_pending_attempt IS NULL AND b.stripe_payment_method IS NOT NULL,false) AS can_recharge
      FROM (SELECT 1) one LEFT JOIN billing_accounts b ON b.workspace_id=wid),
-- Every month with unsettled usage, and this month (a zero row in the current hour) for the allowances.
priced AS (SELECT * FROM billing_priced(wid, ARRAY(SELECT c FROM billing_classify(wid, ARRAY(SELECT d FROM billing_usage_hourly u
    CROSS JOIN LATERAL billing_row_deltas(u.hour, u.meter, u.rate_version, u.quantity - u.settled_quantity, u.refunds) d
    WHERE u.workspace_id=wid AND (u.quantity <> u.settled_quantity OR u.refunds <> '{}')), false) c)
  || ROW(date_trunc('hour', now(), 'UTC'), 'send', 0, 0, false, 0)::billing_counted)),
cur AS (SELECT * FROM priced WHERE month = (date_trunc('month', now() AT TIME ZONE 'UTC'))::date),
p AS (SELECT a.*, cfg.*, (SELECT coalesce(sum(cost_uc - posted_uc), 0) FROM priced) AS open_uc,
        least(r.free_sent, greatest(0, r.free_sent - cur.sent))::int AS sent_left, least(r.free_received, greatest(0, r.free_received - cur.received))::int AS received_left,
        cur.cost_uc AS month_uc, cur.would_be_uc AS month_would_be_uc FROM a, cfg, cur, billing_rates_in(cur.month) r)
SELECT jsonb_build_object('mode',mode,'enforcement',enforcement,'balanceUc',bal::text,'promoUc',promo::text,
  'openUc',open_uc::text,'availableUc',(bal+promo-open_uc)::text,'freeSentLeft',sent_left,'freeReceivedLeft',received_left,'freeEmailsLeft',sent_left,
  'monthCostUc',month_uc::text,'monthWouldBeUc',month_would_be_uc::text,
  'unpaidSince',unpaid_since,'receiveHold',receive_hold,
  'receiveHeld', coalesce(enforcement='enforce' AND receive_hold AND mode='prepaid' AND unpaid_since<=now()-interval '7 days',false),
  'omens', mode<>'prepaid' OR enforcement<>'enforce' OR bal+promo-open_uc>0,
  'canRecharge',can_recharge,'thresholdUc',threshold::text) FROM p
$$;

-- Months from November 2026 settled at version 1, posted once at their version 2 cost (above). The usage row says what
-- came back per direction: the units between the two allowances, as negative payable units.
DO $$
DECLARE b billing_months; r billing_rates; cost bigint; money bigint; take bigint; s bigint; v bigint;
BEGIN
  FOR b IN SELECT * FROM billing_months WHERE month >= DATE '2026-11-01' ORDER BY workspace_id, month LOOP
    r := billing_rates_in(b.month); cost := billing_month_cost(b.month, b.sent, b.received, b.other_uc);
    CONTINUE WHEN cost >= b.posted_uc;
    money := cost - b.posted_uc; take := -least(b.promo_uc, -money);
    s := greatest(0, b.sent - r.free_sent) - greatest(0, b.sent - 3000); v := greatest(0, b.received - r.free_received) - greatest(0, b.received - 3000);
    PERFORM billing_post(b.workspace_id, 'usage', 'usage:'||b.workspace_id||':'||to_char(b.month, 'YYYY-MM')||':rates-'||r.version, -(money - take), -take,
      jsonb_build_object('meters', jsonb_build_object('send', jsonb_build_object('quantity', 0, 'payable', s, 'costUc', s * 20000),
          'receive', jsonb_build_object('quantity', 0, 'payable', v, 'costUc', v * 20000)),
        'costUc', money::text, 'charged', true, 'usageMonth', to_char(b.month, 'YYYY-MM'), 'rateVersion', r.version,
        'repriced', jsonb_build_object('freeSent', r.free_sent, 'freeReceived', r.free_received)), 'system');
    UPDATE billing_months SET posted_uc = cost, promo_uc = promo_uc + take WHERE workspace_id = b.workspace_id AND month = b.month;
  END LOOP;
  UPDATE billing_accounts a SET month_spend_uc = billing_month_cost(m.month, m.sent + m.uncharged_sent, m.received + m.uncharged_received, m.other_uc + m.uncharged_other_uc)
    FROM billing_months m WHERE m.workspace_id = a.workspace_id AND m.month = a.free_month AND a.free_month >= DATE '2026-11-01';
END $$;
