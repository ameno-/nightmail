SET LOCAL lock_timeout='2s';
-- Billing step 2 of 3 (code review billing-1, -3, -7, -9): what a workspace owes is one function of what was metered.
-- Per workspace and UTC month:
--   cost = $0.20 per 1,000 × (max(0, charged sends − 3,000) + max(0, charged received − 3,000)) + Omens + storage,
-- counting only usage metered in hours that were charged (billing_charged, migration 318). Settlement posts each
-- month's cost less what is already posted for it, so the total is the same whatever order or batches hours settle in,
-- and the send limit's open cost is the same function over what isn't settled yet. Two rules follow (Ryan, 2026-11-16):
-- 1. Usage metered while not charged (a free workspace, billing off or in shadow) doesn't use up the month's free 3,000
--    sent and 3,000 received. It did, so a workspace that started paying mid-month found its free sends used up.
-- 2. A refund gives back what the month's cost drops by: one email's price for each unit the month's charged total was
--    above the allowance. It gave back what its own hour had been charged.
-- What doesn't change: where meters and refunds write and when settlement takes them (a refund goes into the current
-- hour, or an earlier month's last hour, noting the hour its mail was metered in; the hourly run takes closed hours),
-- what the settler forgives (whatever it settles while billing isn't charging: the kill-switch), and how storage rounds
-- (each day's cost on its own, here rounded down).
--
-- lock order: begin
-- This migration takes its locks first, in this order; every live path takes a subsequence of them in the same order:
--   billing_config (its row) > the meter fence (314: advisory 31401, exclusive) > billing_accounts (EXCLUSIVE)
-- - set-billing-enforcement: the config row, then billing_settle_all: the fence, then each account.
-- - Meter writes (sends, refunds, received mail, Omens): the fence (shared), then usage rows. The storage day takes the
--   config row before the fence.
-- - The settler and money posts: an account, then usage rows, the ledger, lots and jobs.
-- So it waits for a mode switch in flight (its decision is recorded before the cutover below reads anything, and the
-- cutover writes no decisions of its own), then for every meter write in flight (the cutover sees and settles its usage),
-- then for a settlement or money post in flight; and holds them all off until it commits. Plain reads (the position, the
-- gate, the dashboard) go on. A writer whose transaction began before and writes after it meters into an hour already
-- frozen, and that usage is not charged.
-- lock order: end
SELECT 1 FROM billing_config WHERE singleton FOR UPDATE;
SELECT pg_advisory_xact_lock(31401, 0);
LOCK TABLE billing_accounts IN EXCLUSIVE MODE;

-- What settlement has taken into account for each workspace and month, written only by the settler: the units and
-- cost of charged hours, the same for hours that weren't charged (what free usage is worth), and the money posted. A
-- missing row is a month with nothing settled.
CREATE TABLE IF NOT EXISTS billing_months (
  workspace_id text NOT NULL,
  month date NOT NULL CHECK (month = date_trunc('month', month)),
  sent bigint NOT NULL DEFAULT 0,                      -- charged send recipients settled
  received bigint NOT NULL DEFAULT 0,                  -- charged received messages settled
  other_uc numeric NOT NULL DEFAULT 0,                 -- charged Omens and stored bytes settled, in µ¢
  uncharged_sent bigint NOT NULL DEFAULT 0,
  uncharged_received bigint NOT NULL DEFAULT 0,
  uncharged_other_uc numeric NOT NULL DEFAULT 0,
  posted_uc bigint NOT NULL DEFAULT 0,                 -- usage cost posted for the month (paid + promotional)
  promo_uc bigint NOT NULL DEFAULT 0 CHECK (promo_uc >= 0),  -- the part promotional credit paid: what a refund gives back as promo
  PRIMARY KEY (workspace_id, month));

-- Units of a charged hour that the settler forgave: it settled them while billing wasn't charging (billing off: the
-- kill-switch; or a mode written without settling first), as it always priced such a settlement at $0. A refund of
-- that hour's mail takes forgiven units first and gives nothing back for them, as one of mail settled at $0 always did.
-- Written only by the settler.
CREATE TABLE IF NOT EXISTS billing_forgiven (
  workspace_id text NOT NULL,
  hour timestamptz NOT NULL,
  meter text NOT NULL,
  units bigint NOT NULL CHECK (units >= 0),
  PRIMARY KEY (workspace_id, hour, meter));

-- Installation-simulated sends metered when they were written (billing_config.bill_simulated): a refund of simulated
-- mail gives back only what was metered, whatever the setting is when it comes. Hosted installations send no
-- simulated mail, so this stays empty there.
CREATE TABLE IF NOT EXISTS billing_simulated_sends (email_id text PRIMARY KEY);

-- The cutover, once (below): hours before `hour` are priced as the settler before this migration settled them, and
-- not charged by this model. -infinity on an installation that had metered nothing.
CREATE TABLE IF NOT EXISTS billing_owed_from (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  hour timestamptz NOT NULL,
  migrated_at timestamptz NOT NULL DEFAULT now());

-- A month's cost from its charged totals: the one price of mail and of the free allowances.
CREATE OR REPLACE FUNCTION billing_month_cost(sent bigint, received bigint, other_uc numeric) RETURNS bigint LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT round(20000::numeric * (greatest(0, sent - 3000) + greatest(0, received - 3000)) + other_uc)::bigint
$$;

-- 318's billing_charged with the cutover: no hour before it is charged.
CREATE OR REPLACE FUNCTION billing_charged(wid text, h timestamptz) RETURNS boolean LANGUAGE sql STABLE PARALLEL SAFE AS $$
  SELECT h >= coalesce((SELECT hour FROM billing_owed_from), '-infinity')
     AND coalesce((SELECT charged FROM billing_mode_changes WHERE workspace_id IS NULL AND effective_hour <= h ORDER BY id DESC LIMIT 1), false)
     AND coalesce((SELECT charged FROM billing_mode_changes WHERE workspace_id = wid AND effective_hour <= h ORDER BY id DESC LIMIT 1), true)
$$;

-- The cutover, once, by the settler before this migration (it is replaced below). Every closed hour is settled now, as
-- its next hourly run would (one billing was off for settles at $0, as it would when billing came back on): the locks
-- above have drained every meter write, so nothing is missed. Every hour before the current one is then priced as it
-- settled, and a refund written into one later gives nothing back. That is exact only while no usage has ever been
-- charged money, which was so in production when this shipped (the read-only preflight on the PR), so it is checked:
-- if any usage settlement moved money, or any hour holds charged units a refund could give back, the migration stops
-- instead. It is one transaction: stopped or interrupted, it leaves nothing behind, and the next run starts over.
DO $$
DECLARE cut timestamptz := date_trunc('hour', now(), 'UTC'); w text; paid_ws text[];
BEGIN
  IF EXISTS (SELECT FROM billing_owed_from) THEN RETURN; END IF;
  IF NOT EXISTS (SELECT FROM billing_usage_hourly) THEN INSERT INTO billing_owed_from(hour) VALUES ('-infinity'); RETURN; END IF;
  FOR w IN SELECT DISTINCT workspace_id FROM billing_usage_hourly WHERE (quantity <> settled_quantity OR refunds <> '{}') AND hour < cut ORDER BY 1 LOOP
    PERFORM 1 FROM billing_usage_hourly WHERE workspace_id = w AND (quantity <> settled_quantity OR refunds <> '{}') AND hour < cut
      ORDER BY hour, meter, rate_version FOR UPDATE;
    PERFORM billing_settle(w, cut);
  END LOOP;
  SELECT array_agg(DISTINCT x.workspace_id ORDER BY x.workspace_id) INTO paid_ws FROM (
    SELECT workspace_id FROM billing_ledger WHERE kind = 'usage' AND (paid_uc <> 0 OR promo_uc <> 0)
    UNION ALL SELECT workspace_id FROM billing_usage_paid WHERE units > 0) x;
  IF paid_ws IS NOT NULL THEN
    RAISE EXCEPTION '% workspace(s) were charged money for usage before the owed model', cardinality(paid_ws) USING
      HINT = 'Pricing past hours as settled would change what their refunds give back. Workspaces: ' || array_to_string(paid_ws[1:20], ', ');
  END IF;
  INSERT INTO billing_owed_from(hour) VALUES (cut);
  -- What has settled, month by month: none of it was charged money, so every month is posted at its cost, $0.
  INSERT INTO billing_months (workspace_id, month, sent, received, other_uc, uncharged_sent, uncharged_received, uncharged_other_uc)
  SELECT workspace_id, month,
    coalesce(sum(q) FILTER (WHERE c AND meter = 'send'), 0)::bigint, coalesce(sum(q) FILTER (WHERE c AND meter = 'receive'), 0)::bigint, coalesce(sum(uc) FILTER (WHERE c), 0),
    coalesce(sum(q) FILTER (WHERE NOT c AND meter = 'send'), 0)::bigint, coalesce(sum(q) FILTER (WHERE NOT c AND meter = 'receive'), 0)::bigint, coalesce(sum(uc) FILTER (WHERE NOT c), 0)
  FROM (SELECT workspace_id, (date_trunc('month', hour AT TIME ZONE 'UTC'))::date AS month, billing_charged(workspace_id, hour) AS c, meter, settled_quantity AS q,
          floor(settled_quantity * billing_rate_uc(meter, rate_version, hour) * (meter IN ('omen', 'storage'))::int) AS uc
        FROM billing_usage_hourly WHERE settled_quantity <> 0) h
  GROUP BY 1, 2 ORDER BY 1, 2
  ON CONFLICT (workspace_id, month) DO NOTHING;
  IF EXISTS (SELECT FROM billing_months WHERE billing_month_cost(sent, received, other_uc) <> posted_uc) THEN
    RAISE EXCEPTION 'usage settled before the owed model would cost money under the hours'' history' USING
      HINT = (SELECT 'Workspaces: ' || string_agg(DISTINCT workspace_id, ', ') FROM billing_months WHERE billing_month_cost(sent, received, other_uc) <> posted_uc);
  END IF;
END $$;

-- One usage row's change since it settled, as deltas in the hours its usage was metered in: a refund noted its mail's
-- hour on the row it went into (refunds: epoch seconds, 's' when it went into a past month's last hour, to units) and
-- counts there; the rest is the row's own hour (its own mail, or a send charged again).
DO $$ BEGIN
  IF to_regtype('billing_delta') IS NULL THEN CREATE TYPE billing_delta AS (hour timestamptz, meter text, rate_version smallint, units bigint); END IF;
  IF to_regtype('billing_counted') IS NULL THEN CREATE TYPE billing_counted AS (hour timestamptz, meter text, units bigint, uc bigint, charged boolean, forgive bigint); END IF;
END $$;
CREATE OR REPLACE FUNCTION billing_row_deltas(h timestamptz, m text, rv smallint, delta bigint, refunds jsonb) RETURNS SETOF billing_delta
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT h, m, rv, delta - coalesce((SELECT sum(v::bigint) FROM jsonb_each_text(refunds) x(k, v)), 0)
  UNION ALL SELECT to_timestamp(ltrim(k, 's')::bigint), m, rv, v::bigint FROM jsonb_each_text(refunds) x(k, v)
$$;

-- What deltas count for, per hour and meter: charged or not (billing_charged), and their value in µ¢ for Omens and
-- storage (each hour's on its own, rounded down: storage is metered a day per row). A refund in a charged hour takes
-- the units forgiven there first, which count as not charged. With forgiving (the settler, settling while billing
-- isn't charging) new units of a charged hour are forgiven. forgive is the change to billing_forgiven.
CREATE OR REPLACE FUNCTION billing_classify(wid text, deltas billing_delta[], forgiving boolean) RETURNS SETOF billing_counted LANGUAGE sql STABLE AS $$
  WITH n AS (SELECT x.hour, x.meter, x.rate_version, sum(x.units)::bigint AS units FROM unnest(deltas) x GROUP BY 1, 2, 3),
  k AS (SELECT n.*, billing_charged(wid, n.hour) AS c, coalesce(f.units, 0) AS free,
          CASE WHEN n.meter IN ('omen', 'storage') THEN billing_rate_uc(n.meter, n.rate_version, n.hour) ELSE 0 END AS rate
        FROM n LEFT JOIN billing_forgiven f ON f.workspace_id = wid AND f.hour = n.hour AND f.meter = n.meter
        WHERE n.units <> 0),
  s AS (SELECT k.*, CASE WHEN NOT k.c THEN 0 WHEN k.units > 0 THEN CASE WHEN forgiving THEN 0 ELSE k.units END
                         ELSE k.units + least(-k.units, k.free) END AS paying FROM k)
  SELECT x.* FROM s CROSS JOIN LATERAL (VALUES
      (s.hour, s.meter, s.paying, floor(s.paying * s.rate)::bigint, true, 0::bigint),
      (s.hour, s.meter, s.units - s.paying, floor((s.units - s.paying) * s.rate)::bigint, false,
        CASE WHEN NOT s.c THEN 0 WHEN s.units > 0 THEN s.units - s.paying ELSE -least(-s.units, s.free) END)) x(hour, meter, units, uc, charged, forgive)
  WHERE x.units <> 0
$$;

-- Each month that `counted` touches, priced as if it were settled too: its totals then, by whether they are charged,
-- and the changes `counted` makes to them; its cost then, and what it would cost if every hour were charged, then and
-- before; and what is posted for it. The settler prices what it settles with this; billing_position prices everything
-- unsettled with it.
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
  SELECT month, c, s, r, u, us, ur, uu, billing_month_cost(s, r, u), billing_month_cost(s + us, r + ur, u + uu), billing_month_cost(ps, pr, pu), posted, promo FROM t
$$;

-- Settles a workspace's usage of hours before cutoff, as before: every row no writer holds (a held row settles next
-- run), with the refunds of other hours' mail it holds. The one exception is the current hour (a cutoff past now: a
-- mode switch), whose mode can still change: only the refunds it holds for mail of closed hours settle with it. Each
-- month the rows touch posts its cost less what is posted for it, as one usage ledger row per month (detail.usageMonth):
-- refunds first, giving promotional credit back up to what promo paid for that month, then charges, spending promo
-- first. A month with nothing charged posts $0 with what it would have cost (detail.charged false), as before. What it
-- settles while billing isn't charging (off, shadow, or a free workspace) is forgiven.
CREATE OR REPLACE FUNCTION billing_settle(wid text, cutoff timestamptz) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE a billing_accounts; cfg billing_config; cut timestamptz := least(cutoff, date_trunc('hour', now(), 'UTC'));
  deltas billing_delta[]; counted billing_counted[]; n_rows int; p record; money bigint; take bigint; promo_left bigint; total bigint; recharging boolean;
  det jsonb; posted jsonb; ids text[] := '{}'; charged_any boolean := false; money_total bigint := 0; would_be_total bigint := 0;
  this_month date := (date_trunc('month', now() AT TIME ZONE 'UTC'))::date; mine billing_months;
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
    money := p.cost_uc - p.posted_uc;
    take := CASE WHEN money < 0 THEN -least(p.promo_uc, -money) ELSE least(promo_left, money) END;
    promo_left := promo_left - take;
    -- Per meter: units settled, units beyond the allowance (or charged, for Omens and storage) and their cost; for a
    -- month not charged, what they would have cost.
    WITH d AS (SELECT x.* FROM unnest(counted) x WHERE (date_trunc('month', x.hour AT TIME ZONE 'UTC'))::date = p.month),
    m AS (SELECT d.meter, sum(d.units)::bigint AS q, coalesce(sum(d.units) FILTER (WHERE d.charged OR NOT p.charged), 0)::bigint AS counted,
            coalesce(sum(d.uc) FILTER (WHERE d.charged OR NOT p.charged), 0) AS rated, min(d.hour) AS first, max(d.hour) AS last FROM d GROUP BY d.meter),
    v AS (SELECT m.*, CASE WHEN m.meter IN ('send', 'receive') THEN greatest(0, n - 3000) - greatest(0, n - m.counted - 3000)
                           WHEN m.meter IN ('omen', 'storage') THEN m.counted ELSE 0 END AS payable
          FROM m CROSS JOIN LATERAL (SELECT CASE m.meter WHEN 'send' THEN p.sent + CASE WHEN p.charged THEN 0 ELSE p.uncharged_sent END
            WHEN 'receive' THEN p.received + CASE WHEN p.charged THEN 0 ELSE p.uncharged_received END END AS n) t)
    SELECT jsonb_build_object('meters', jsonb_object_agg(v.meter, jsonb_build_object('quantity', v.q, 'payable', v.payable,
        'costUc', CASE WHEN v.meter IN ('send', 'receive') THEN v.payable * 20000 WHEN v.meter IN ('omen', 'storage') THEN v.rated ELSE 0 END)),
      'costUc', (CASE WHEN p.charged THEN money ELSE p.would_be_uc - p.prior_would_be_uc END)::text, 'charged', p.charged,
      'from', min(v.first), 'to', max(v.last) + interval '1 hour', 'usageMonth', to_char(p.month, 'YYYY-MM'), 'rateVersion', 1) INTO det FROM v;
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
      month_spend_uc=coalesce(billing_month_cost(mine.sent + mine.uncharged_sent, mine.received + mine.uncharged_received, mine.other_uc + mine.uncharged_other_uc), 0)
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
    IF total <= 0 AND coalesce(mine.sent, 0) >= 3000 AND a.empty_since IS NULL THEN
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

-- The money position the gate, the summary, recharge and Omens read: the same prices over every unsettled row, so
-- openUc is what settling everything now would post (a refund counts as soon as it is written, for no more than it
-- will give back), and the free allowances left are this month's less its charged usage, settled or not. monthCostUc
-- is this month's cost so far; monthWouldBeUc is what it would be if every hour were charged (what a free workspace's
-- usage is worth).
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
        least(3000, greatest(0, 3000 - cur.sent))::int AS sent_left, least(3000, greatest(0, 3000 - cur.received))::int AS received_left,
        cur.cost_uc AS month_uc, cur.would_be_uc AS month_would_be_uc FROM a, cfg, cur)
SELECT jsonb_build_object('mode',mode,'enforcement',enforcement,'balanceUc',bal::text,'promoUc',promo::text,
  'openUc',open_uc::text,'availableUc',(bal+promo-open_uc)::text,'freeSentLeft',sent_left,'freeReceivedLeft',received_left,'freeEmailsLeft',sent_left,
  'monthCostUc',month_uc::text,'monthWouldBeUc',month_would_be_uc::text,
  'unpaidSince',unpaid_since,'receiveHold',receive_hold,
  'receiveHeld', coalesce(enforcement='enforce' AND receive_hold AND mode='prepaid' AND unpaid_since<=now()-interval '7 days',false),
  'omens', mode<>'prepaid' OR enforcement<>'enforce' OR bal+promo-open_uc>0,
  'canRecharge',can_recharge,'thresholdUc',threshold::text) FROM p
$$;

-- Send meters write a send into the hour it was created in (the hour its refund notes), after the workspace's
-- send-meter lock (31403): a statement's refunds can write several hours' rows (the current one, earlier months' last
-- ones), and with the lock two transactions never take a workspace's rows in opposite orders. Installation-simulated
-- mail metered is recorded (billing_simulated_sends).
CREATE OR REPLACE FUNCTION billing_meter_sends() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE sim boolean := (SELECT bill_simulated FROM billing_config WHERE singleton);
BEGIN
  PERFORM billing_meter_fence(w) FROM (SELECT DISTINCT workspace_id AS w FROM new_mail ORDER BY 1) x;
  PERFORM pg_advisory_xact_lock(31403, h) FROM (SELECT DISTINCT hashtext(workspace_id) AS h FROM new_mail ORDER BY 1) x;
  INSERT INTO billing_usage_hourly AS u (workspace_id,hour,meter,rate_version,quantity)
  SELECT n.workspace_id, date_trunc('hour',n.created_at,'UTC'),
         CASE WHEN (n.feedback_topic_arn IS NULL AND pc.kind='shared')
                OR EXISTS (SELECT FROM provider_pool_regions p WHERE p.feedback_topic_arn=n.feedback_topic_arn)
              THEN 'send' ELSE 'byo_send' END,
         1, sum(jsonb_array_length(n.to_addresses||n.cc_addresses||n.bcc_addresses))
  FROM new_mail n
  CROSS JOIN LATERAL (SELECT kind FROM provider_connections WHERE workspace_id=n.workspace_id ORDER BY kind LIMIT 1) pc
  WHERE (NOT n.simulated OR sim) AND hosted_charged(n.status,n.provider_id,n.error_code)
  GROUP BY 1,2,3 ORDER BY 1,2,3
  ON CONFLICT (workspace_id,hour,meter,rate_version) DO UPDATE SET quantity=u.quantity+excluded.quantity;
  IF sim THEN
    INSERT INTO billing_simulated_sends(email_id) SELECT n.id FROM new_mail n
      WHERE n.simulated AND hosted_charged(n.status,n.provider_id,n.error_code) AND EXISTS (SELECT FROM provider_connections c WHERE c.workspace_id=n.workspace_id)
      ORDER BY 1 ON CONFLICT DO NOTHING;
  END IF;
  RETURN NULL;
END $$;

-- 314's change of a send between charged and not (a cancellation, a rejection before SES, a validation suppression,
-- or a later delivery): a refund goes into the current hour, or an earlier month's mail into that month's last hour,
-- noting the hour its mail was metered in (where billing_row_deltas counts it); settlement takes it once that hour has
-- closed, as before. Two changes:
-- - A send charged again counts now, in the current hour, as before; one of an earlier month's mail isn't charged (it
--   was priced against that month under today's mode). The send path never refunds a send after that: cancellations
--   are of queued mail, and a delivery is kept over a later suppression (migration 153).
-- - Simulated mail is refunded only if it was metered (billing_simulated_sends); mail written before this migration as
--   before, by today's bill_simulated.
CREATE OR REPLACE FUNCTION billing_adjust_sends() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE d bigint; m text; h timestamptz; k text; now_hour timestamptz := date_trunc('hour',now(),'UTC');
  earlier boolean := date_trunc('month',NEW.created_at,'UTC') < date_trunc('month',now(),'UTC');
  sim boolean := (SELECT bill_simulated FROM billing_config WHERE singleton);
BEGIN
  d := (hosted_charged(NEW.status,NEW.provider_id,NEW.error_code)::int - hosted_charged(OLD.status,OLD.provider_id,OLD.error_code)::int)
       * jsonb_array_length(NEW.to_addresses||NEW.cc_addresses||NEW.bcc_addresses);
  m := CASE WHEN EXISTS (SELECT FROM provider_pool_regions p WHERE p.feedback_topic_arn=NEW.feedback_topic_arn) THEN 'send'
    ELSE (SELECT CASE WHEN NEW.feedback_topic_arn IS NULL AND kind='shared' THEN 'send' ELSE 'byo_send' END
          FROM provider_connections WHERE workspace_id=NEW.workspace_id ORDER BY kind LIMIT 1) END;
  IF d=0 OR m IS NULL OR (d > 0 AND earlier) THEN RETURN NULL; END IF;
  IF NEW.simulated THEN
    IF d < 0 THEN
      DELETE FROM billing_simulated_sends WHERE email_id=NEW.id;
      IF NOT FOUND AND NOT (sim AND NEW.created_at < (SELECT migrated_at FROM billing_owed_from)) THEN RETURN NULL; END IF;
    ELSIF sim THEN INSERT INTO billing_simulated_sends(email_id) VALUES (NEW.id) ON CONFLICT DO NOTHING;
    ELSE RETURN NULL;
    END IF;
  END IF;
  PERFORM billing_meter_fence(NEW.workspace_id);
  PERFORM pg_advisory_xact_lock(31403, hashtext(NEW.workspace_id));
  -- Month arithmetic on UTC wall-clock timestamps: timestamptz + interval '1 month' would follow the session TimeZone.
  h := CASE WHEN earlier THEN (date_trunc('month',NEW.created_at AT TIME ZONE 'UTC') + interval '1 month' - interval '1 hour') AT TIME ZONE 'UTC' ELSE now_hour END;
  k := CASE WHEN h < now_hour THEN 's' ELSE '' END || extract(epoch FROM date_trunc('hour', NEW.created_at, 'UTC'))::bigint::text;
  INSERT INTO billing_usage_hourly AS u (workspace_id,hour,meter,rate_version,quantity,settled_quantity,refunds)
    VALUES (NEW.workspace_id,h,m,1,d,0,CASE WHEN d<0 THEN jsonb_build_object(k,d) ELSE '{}' END)
    ON CONFLICT (workspace_id,hour,meter,rate_version) DO UPDATE SET quantity=u.quantity+excluded.quantity,
      refunds=CASE WHEN excluded.quantity<0 THEN u.refunds || jsonb_build_object(k, coalesce((u.refunds->>k)::bigint,0)+excluded.quantity) ELSE u.refunds END;
  RETURN NULL;
END $$;

-- 314's billing_post, refusing a settlement by the settler before this migration: one that was waiting for this
-- migration's lock and then resumed in its old code would count usage in a way billing_months doesn't. It fails, and
-- the next run settles that usage.
CREATE OR REPLACE FUNCTION billing_post(wid text, k text, src text, paid bigint, promo bigint, det jsonb, who text) RETURNS jsonb
LANGUAGE plpgsql AS $$
DECLARE a billing_accounts; eid bigint;
  credit boolean := k IN ('topup','grant','refund_release','dispute_reversal') OR (k='adjustment' AND paid+promo>0);
BEGIN
  IF k='usage' AND det ? 'rateVersion' AND NOT det ? 'usageMonth' THEN
    RAISE EXCEPTION 'usage settled by the settler before the owed model' USING ERRCODE='55000', HINT='The next settlement run settles it.';
  END IF;
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
