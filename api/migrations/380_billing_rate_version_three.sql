SET LOCAL lock_timeout='2s';
-- Rate version 3 (2026-11-21): AI decisions (the omen meter) are free. Version 2 charged $0.10 per 1,000. Email,
-- the free allowances (5,000 sent and 5,000 received) and storage don't change. Decisions are still metered
-- (billing_usage_hourly, meter 'omen') and settled like any usage, so their volume still shows in usage, the ledger and
-- the operator's view: they settle at $0.
--
-- A rate version prices whole UTC months (367), so version 3 can't start mid-month: it prices November 2026, the month
-- this ships in, and every month after it, in place of version 2. Months before it keep version 1, decisions at $0.10
-- per 1,000: no earlier month is repriced or charged again.
--
-- November's decisions settled so far were priced at $0.10 per 1,000. As 367 did for the allowance, each month from
-- November 2026 is posted once at its version 3 cost: what its charged decisions cost comes back to the balance as a
-- usage row for that month (promotional credit first, up to what promo paid for it), and what its uncharged ones were
-- worth leaves its would-be cost. That runs first, while billing_rate_uc still prices them, and takes out what each
-- hour's decisions were priced at, as the settler priced them: charged when billing_charged says so, less the units it
-- forgave. Run again, it takes out nothing.
--
-- Nothing withholds decisions from an empty balance any more (ingest stops asking billing_position), so the position
-- no longer reports omens.
--
-- lock order: begin
-- billing_accounts (EXCLUSIVE), then what a settlement takes after an account (the ledger, credit lots), as 367: it
-- waits for every settlement and money post in flight and holds new ones until it commits, so each month it posts is
-- read after its last settlement at the old price. Meter writes and plain reads (the position, the gate, the dashboard)
-- go on.
-- lock order: end
LOCK TABLE billing_accounts IN EXCLUSIVE MODE;

DO $$
DECLARE b record; cost bigint; money bigint; take bigint;
BEGIN
  FOR b IN
    WITH h AS (SELECT workspace_id, hour, sum(settled_quantity)::bigint AS units FROM billing_usage_hourly
        WHERE meter = 'omen' AND hour >= TIMESTAMPTZ '2026-11-01 00:00:00+00' AND settled_quantity <> 0 GROUP BY 1, 2),
      p AS (SELECT h.workspace_id, (date_trunc('month', h.hour AT TIME ZONE 'UTC'))::date AS month, h.units,
          CASE WHEN billing_charged(h.workspace_id, h.hour) THEN h.units - coalesce(f.units, 0) ELSE 0 END AS paying,
          billing_rate_uc('omen', 1::smallint, h.hour) AS rate
        FROM h LEFT JOIN billing_forgiven f ON f.workspace_id = h.workspace_id AND f.hour = h.hour AND f.meter = 'omen'),
      o AS (SELECT workspace_id, month, sum(paying)::bigint AS paying, sum(floor(paying * rate))::bigint AS charged_uc,
          sum(floor((units - paying) * rate))::bigint AS uncharged_uc FROM p GROUP BY 1, 2)
    SELECT m.workspace_id, m.month, m.sent, m.received, m.other_uc, m.uncharged_other_uc, m.posted_uc, m.promo_uc, o.paying, o.charged_uc, o.uncharged_uc
      FROM o JOIN billing_months m USING (workspace_id, month) WHERE o.charged_uc <> 0 OR o.uncharged_uc <> 0 ORDER BY 1, 2
  LOOP
    -- Settled decisions are part of the month's settled usage, so this can't happen; if it does, nothing changes.
    IF b.charged_uc > b.other_uc OR b.uncharged_uc > b.uncharged_other_uc THEN
      RAISE EXCEPTION 'the AI decisions settled for % in % are worth more than its settled usage', b.workspace_id, to_char(b.month, 'YYYY-MM') USING
        HINT = 'billing_months doesn''t match billing_usage_hourly for that month. Nothing was repriced.';
    END IF;
    cost := billing_month_cost(b.month, b.sent, b.received, b.other_uc - b.charged_uc);
    money := least(0, cost - b.posted_uc); take := -least(b.promo_uc, -money);
    IF money < 0 THEN
      PERFORM billing_post(b.workspace_id, 'usage', 'usage:'||b.workspace_id||':'||to_char(b.month, 'YYYY-MM')||':rates-3', -(money - take), -take,
        jsonb_build_object('meters', jsonb_build_object('omen', jsonb_build_object('quantity', 0, 'payable', -b.paying, 'costUc', -b.charged_uc)),
          'costUc', money::text, 'charged', true, 'usageMonth', to_char(b.month, 'YYYY-MM'), 'rateVersion', 3,
          'repriced', jsonb_build_object('decisionUc', 0)), 'system');
    END IF;
    UPDATE billing_months SET other_uc = other_uc - b.charged_uc, uncharged_other_uc = uncharged_other_uc - b.uncharged_uc,
        posted_uc = posted_uc + money, promo_uc = promo_uc + take
      WHERE workspace_id = b.workspace_id AND month = b.month;
    -- The month counters of the settler before 333's, for what still reads them.
    UPDATE billing_accounts a SET month_spend_uc = billing_month_cost(m.month, m.sent + m.uncharged_sent, m.received + m.uncharged_received, m.other_uc + m.uncharged_other_uc)
      FROM billing_months m WHERE m.workspace_id = b.workspace_id AND m.month = b.month AND a.workspace_id = m.workspace_id AND a.free_month = m.month;
  END LOOP;
END $$;

-- Each month's rates (367): version 3 from November 2026, version 1 before it.
CREATE OR REPLACE FUNCTION billing_rates_in(month date) RETURNS billing_rates LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT CASE WHEN month >= DATE '2026-11-01' THEN ROW(3, 5000, 5000)::billing_rates ELSE ROW(1, 3000, 3000)::billing_rates END
$$;

-- 314's unit prices, with AI decisions priced by the rate version of the month they were metered in: $0 from version 3.
CREATE OR REPLACE FUNCTION billing_rate_uc(meter text, rate_version smallint, hour timestamptz) RETURNS numeric LANGUAGE sql STABLE AS $$
  SELECT CASE WHEN meter IN ('send','receive') THEN 20000
    WHEN meter='omen' THEN CASE WHEN (billing_rates_in((date_trunc('month', hour AT TIME ZONE 'UTC'))::date)).version >= 3 THEN 0 ELSE 10000 END
    WHEN meter='storage' THEN CASE WHEN c.storage_billing_from IS NULL OR hour < c.storage_billing_from::timestamp AT TIME ZONE 'UTC' THEN 0
      ELSE 25000000::numeric / (1e9 * extract(day FROM date_trunc('month', hour AT TIME ZONE 'UTC') + interval '1 month - 1 day')) END
    ELSE 0 END FROM billing_config c WHERE c.singleton
$$;

-- 367's billing_position without omens.
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
  'canRecharge',can_recharge,'thresholdUc',threshold::text) FROM p
$$;
