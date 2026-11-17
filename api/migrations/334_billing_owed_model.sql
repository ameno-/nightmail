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
--
-- The settler and every money post lock an account first: this waits for the one in flight and holds the rest off
-- until the new settler is in, so no settlement straddles the switch. Plain reads (the position, the gate) go on, and so
-- do mail writes.
LOCK TABLE billing_accounts IN EXCLUSIVE MODE;

-- What settlement has taken into account for each workspace and month, written only by the settler: the units and
-- cost of charged hours, the same for hours that weren't charged (what free usage is worth), and the money posted. A
-- missing row is a month with nothing settled.
CREATE TABLE IF NOT EXISTS billing_months (
  workspace_id text NOT NULL,
  month date NOT NULL CHECK (month = date_trunc('month', month)),
  sent bigint NOT NULL DEFAULT 0,                      -- charged send recipients settled
  received bigint NOT NULL DEFAULT 0,                  -- charged received messages settled
  other_uc numeric NOT NULL DEFAULT 0,                 -- charged Omens and stored bytes settled, in µ¢ (unrounded)
  uncharged_sent bigint NOT NULL DEFAULT 0,
  uncharged_received bigint NOT NULL DEFAULT 0,
  uncharged_other_uc numeric NOT NULL DEFAULT 0,
  posted_uc bigint NOT NULL DEFAULT 0,                 -- usage cost posted for the month (paid + promotional)
  promo_uc bigint NOT NULL DEFAULT 0 CHECK (promo_uc >= 0),  -- the part promotional credit paid: what a refund gives back as promo
  PRIMARY KEY (workspace_id, month));

-- A month's cost from its charged totals: the one price of mail and of the free allowances.
CREATE OR REPLACE FUNCTION billing_month_cost(sent bigint, received bigint, other_uc numeric) RETURNS bigint LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT round(20000::numeric * (greatest(0, sent - 3000) + greatest(0, received - 3000)) + other_uc)::bigint
$$;

-- The cutover, once. Every closed hour is settled now by the settler before this migration, as its next hourly run
-- would (one that billing was off for settles at $0, as it would when billing came back on). Every hour before the
-- current one is then frozen as not charged: it stays as that settler priced it, and a refund written into it later
-- gives nothing back. That is exact only while no usage has ever been charged money, which was so in production when
-- this shipped (the read-only preflight on the PR), so it is checked: if any usage settlement moved money, or any
-- hour holds charged units a refund could give back, the migration stops instead.
DO $$
DECLARE cut timestamptz := date_trunc('hour', now(), 'UTC'); w text; was boolean; paid_ws text[];
BEGIN
  -- Done already, or nothing was ever metered (a new installation): nothing to freeze.
  IF EXISTS (SELECT FROM billing_mode_changes WHERE workspace_id IS NULL AND actor = 'cutover') OR NOT EXISTS (SELECT FROM billing_usage_hourly) THEN RETURN; END IF;
  FOR w IN SELECT DISTINCT workspace_id FROM billing_usage_hourly WHERE (quantity <> settled_quantity OR refunds <> '{}') AND hour < cut ORDER BY 1 LOOP
    -- Wait for rows a writer holds, which the settler would skip.
    PERFORM 1 FROM billing_usage_hourly WHERE workspace_id = w AND (quantity <> settled_quantity OR refunds <> '{}') AND hour < cut
      ORDER BY hour, meter, rate_version FOR UPDATE;
    PERFORM billing_settle(w, cut);
  END LOOP;
  SELECT array_agg(DISTINCT x.workspace_id ORDER BY x.workspace_id) INTO paid_ws FROM (
    SELECT workspace_id FROM billing_ledger WHERE kind = 'usage' AND (paid_uc <> 0 OR promo_uc <> 0)
    UNION ALL SELECT workspace_id FROM billing_usage_paid WHERE units > 0) x;
  IF paid_ws IS NOT NULL THEN
    RAISE EXCEPTION '% workspace(s) were charged money for usage before 334', cardinality(paid_ws) USING
      HINT = 'Freezing past hours as not charged would change what their refunds give back. Workspaces: ' || array_to_string(paid_ws[1:20], ', ');
  END IF;
  -- The installation's history: not charged before the current hour; from it on as recorded (the decision in effect
  -- now, then each decision taking effect later, in order).
  was := coalesce((SELECT m.charged FROM billing_mode_changes m WHERE m.workspace_id IS NULL AND m.effective_hour <= cut ORDER BY m.id DESC LIMIT 1), false);
  INSERT INTO billing_mode_changes(workspace_id, charged, effective_hour, actor, reason) VALUES
    (NULL, false, '-infinity', 'cutover', 'hours before ' || to_char(cut AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:00') || ' UTC were settled by the settler before 334'),
    (NULL, was, cut, 'cutover', 'as recorded');
  INSERT INTO billing_mode_changes(workspace_id, charged, effective_hour, actor, reason)
    SELECT NULL, m.charged, m.effective_hour, m.actor, m.reason FROM billing_mode_changes m
    WHERE m.workspace_id IS NULL AND m.effective_hour > cut AND m.actor <> 'cutover' ORDER BY m.id;
  -- What has settled, month by month, by the hours' history: none of it was charged money, so every month is posted
  -- at its cost, $0.
  INSERT INTO billing_months (workspace_id, month, sent, received, other_uc, uncharged_sent, uncharged_received, uncharged_other_uc)
  SELECT workspace_id, month,
    coalesce(sum(q) FILTER (WHERE c AND meter = 'send'), 0)::bigint, coalesce(sum(q) FILTER (WHERE c AND meter = 'receive'), 0)::bigint, coalesce(sum(uc) FILTER (WHERE c), 0),
    coalesce(sum(q) FILTER (WHERE NOT c AND meter = 'send'), 0)::bigint, coalesce(sum(q) FILTER (WHERE NOT c AND meter = 'receive'), 0)::bigint, coalesce(sum(uc) FILTER (WHERE NOT c), 0)
  FROM (SELECT workspace_id, (date_trunc('month', hour AT TIME ZONE 'UTC'))::date AS month, billing_charged(workspace_id, hour) AS c, meter, settled_quantity AS q,
          CASE WHEN meter IN ('omen', 'storage') THEN settled_quantity * billing_rate_uc(meter, rate_version, hour) ELSE 0 END AS uc
        FROM billing_usage_hourly WHERE settled_quantity <> 0) h
  GROUP BY 1, 2 ORDER BY 1, 2
  ON CONFLICT (workspace_id, month) DO NOTHING;
  IF EXISTS (SELECT FROM billing_months WHERE billing_month_cost(sent, received, other_uc) <> posted_uc) THEN
    RAISE EXCEPTION 'usage settled before 334 would cost money under the hours'' history' USING
      HINT = (SELECT 'Workspaces: ' || string_agg(DISTINCT workspace_id, ', ') FROM billing_months WHERE billing_month_cost(sent, received, other_uc) <> posted_uc);
  END IF;
END $$;

-- One usage row's change since it settled, as deltas in the hours the usage was metered in. A refund written before 334
-- noted its origin hour on the row it landed in (refunds: epoch seconds, 's' when the origin may have settled, to
-- units); it counts in that hour, where billing_adjust_sends writes one now.
DO $$ BEGIN
  IF to_regtype('billing_delta') IS NULL THEN CREATE TYPE billing_delta AS (hour timestamptz, meter text, rate_version smallint, units bigint); END IF;
END $$;
CREATE OR REPLACE FUNCTION billing_row_deltas(h timestamptz, m text, rv smallint, delta bigint, refunds jsonb) RETURNS SETOF billing_delta
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT h, m, rv, delta - coalesce((SELECT sum(v::bigint) FROM jsonb_each_text(refunds) x(k, v)), 0)
  UNION ALL SELECT to_timestamp(ltrim(k, 's')::bigint), m, rv, v::bigint FROM jsonb_each_text(refunds) x(k, v)
$$;

-- Each month that `open` touches, priced as if `open` were settled too: its totals then, by whether their hours were
-- charged, and the changes `open` makes to them; its cost then, and what it would cost if every hour were charged, then
-- and before; and what is posted for it. The settler prices the rows it settles with this; billing_position prices
-- every unsettled row with it.
CREATE OR REPLACE FUNCTION billing_priced(wid text, open billing_delta[]) RETURNS TABLE (month date, charged boolean,
  sent bigint, received bigint, other_uc numeric, uncharged_sent bigint, uncharged_received bigint, uncharged_other_uc numeric,
  cost_uc bigint, would_be_uc bigint, prior_would_be_uc bigint, posted_uc bigint, promo_uc bigint) LANGUAGE sql STABLE AS $$
  WITH o AS (SELECT (date_trunc('month', x.hour AT TIME ZONE 'UTC'))::date AS month, billing_charged(wid, x.hour) AS c, x.meter, x.units,
               CASE WHEN x.meter IN ('omen', 'storage') THEN x.units * billing_rate_uc(x.meter, x.rate_version, x.hour) ELSE 0 END AS uc
             FROM unnest(open) x),
  g AS (SELECT o.month, bool_or(o.c) AS c,
          coalesce(sum(o.units) FILTER (WHERE o.c AND o.meter = 'send'), 0)::bigint AS s, coalesce(sum(o.units) FILTER (WHERE o.c AND o.meter = 'receive'), 0)::bigint AS r,
          coalesce(sum(o.uc) FILTER (WHERE o.c), 0) AS u,
          coalesce(sum(o.units) FILTER (WHERE NOT o.c AND o.meter = 'send'), 0)::bigint AS us, coalesce(sum(o.units) FILTER (WHERE NOT o.c AND o.meter = 'receive'), 0)::bigint AS ur,
          coalesce(sum(o.uc) FILTER (WHERE NOT o.c), 0) AS uu
        FROM o GROUP BY 1),
  t AS (SELECT g.month, g.c, coalesce(b.sent, 0) + g.s AS s, coalesce(b.received, 0) + g.r AS r, coalesce(b.other_uc, 0) + g.u AS u,
          coalesce(b.uncharged_sent, 0) + g.us AS us, coalesce(b.uncharged_received, 0) + g.ur AS ur, coalesce(b.uncharged_other_uc, 0) + g.uu AS uu,
          coalesce(b.sent + b.uncharged_sent, 0) AS ps, coalesce(b.received + b.uncharged_received, 0) AS pr, coalesce(b.other_uc + b.uncharged_other_uc, 0) AS pu,
          coalesce(b.posted_uc, 0) AS posted, coalesce(b.promo_uc, 0) AS promo
        FROM g LEFT JOIN billing_months b ON b.workspace_id = wid AND b.month = g.month)
  SELECT month, c, s, r, u, us, ur, uu, billing_month_cost(s, r, u), billing_month_cost(s + us, r + ur, u + uu), billing_month_cost(ps, pr, pu), posted, promo FROM t
$$;

-- Settles a workspace's usage of hours before cutoff (never the current hour, whose mode can still change). The rows
-- no writer holds (a held row settles next run) move settled_quantity up to what was read, and each month they touch
-- posts its cost less what is posted for it, as one usage ledger row per month (detail.usageMonth). A row a refund wrote
-- into at or after the cutoff (adjusted_at) waits for a later run, as a refund written into the current hour always
-- did: the hourly run settles it once the hour it was written in has closed, after that hour's credit expiries. A month's refunds give promotional credit back first, up to what promo paid for that month, and its charges
-- spend promo first; refunds post before charges. A month whose hours weren't charged posts $0 with what it would have
-- cost (detail.charged false), as before.
CREATE OR REPLACE FUNCTION billing_settle(wid text, cutoff timestamptz) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE a billing_accounts; cfg billing_config; cut timestamptz := least(cutoff, date_trunc('hour', now(), 'UTC'));
  deltas billing_delta[]; n_rows int; p record; money bigint; take bigint; promo_left bigint; total bigint; recharging boolean;
  det jsonb; posted jsonb; ids text[] := '{}'; charged_any boolean := false; money_total bigint := 0; would_be_total bigint := 0;
  this_month date := (date_trunc('month', now() AT TIME ZONE 'UTC'))::date;
BEGIN
  INSERT INTO billing_accounts(workspace_id) VALUES (wid) ON CONFLICT DO NOTHING;
  SELECT * INTO a FROM billing_accounts WHERE workspace_id=wid FOR UPDATE SKIP LOCKED;
  IF NOT FOUND THEN RETURN '{"busy":true}'; END IF;
  SELECT * INTO cfg FROM billing_config WHERE singleton;
  WITH open AS (SELECT hour, meter, rate_version, quantity, settled_quantity, refunds FROM billing_usage_hourly
      WHERE workspace_id=wid AND (quantity <> settled_quantity OR refunds <> '{}') AND hour < cut AND (adjusted_at IS NULL OR adjusted_at < cutoff)
      ORDER BY hour, meter, rate_version FOR UPDATE SKIP LOCKED),
    closed AS (UPDATE billing_usage_hourly u SET settled_quantity=o.quantity, refunds='{}' FROM open o
      WHERE u.workspace_id=wid AND u.hour=o.hour AND u.meter=o.meter AND u.rate_version=o.rate_version
      RETURNING o.hour, o.meter, o.rate_version, o.quantity - o.settled_quantity AS delta, o.refunds)
  SELECT count(DISTINCT (c.hour, c.meter, c.rate_version))::int, array_agg(d ORDER BY d.hour, d.meter) INTO n_rows, deltas
    FROM closed c CROSS JOIN LATERAL billing_row_deltas(c.hour, c.meter, c.rate_version, c.delta, c.refunds) d;
  IF coalesce(n_rows, 0) = 0 THEN RETURN jsonb_build_object('entries', 0); END IF;
  promo_left := a.promo_uc;
  FOR p IN SELECT * FROM billing_priced(wid, deltas) ORDER BY cost_uc - posted_uc >= 0, month LOOP
    money := p.cost_uc - p.posted_uc;
    take := CASE WHEN money < 0 THEN -least(p.promo_uc, -money) ELSE least(promo_left, money) END;
    promo_left := promo_left - take;
    -- Per meter: units settled, units beyond the allowance (or charged, for Omens and storage) and their cost; for a
    -- month not charged, what they would have cost.
    WITH d AS (SELECT x.*, billing_charged(wid, x.hour) AS c FROM unnest(deltas) x WHERE (date_trunc('month', x.hour AT TIME ZONE 'UTC'))::date = p.month),
    m AS (SELECT d.meter, sum(d.units)::bigint AS q, coalesce(sum(d.units) FILTER (WHERE d.c OR NOT p.charged), 0)::bigint AS counted,
            coalesce(sum(d.units * billing_rate_uc(d.meter, d.rate_version, d.hour)) FILTER (WHERE d.c OR NOT p.charged), 0) AS rated,
            min(d.hour) AS first, max(d.hour) AS last FROM d GROUP BY d.meter),
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
  SELECT * INTO a FROM billing_accounts WHERE workspace_id=wid;
  -- Notices and auto-recharge, as before, for real money only: enforce, prepaid.
  IF cfg.mode='enforce' AND a.mode='prepaid' THEN
    total := a.balance_uc + a.promo_uc;
    recharging := a.recharge_enabled AND a.recharge_disabled_at IS NULL AND a.stripe_payment_method IS NOT NULL;
    IF total > 0 AND total < a.low_balance_uc AND a.low_since IS NULL AND NOT recharging THEN
      UPDATE billing_accounts SET low_since=now() WHERE workspace_id=wid RETURNING * INTO a;
      PERFORM billing_notice(wid, 'low_balance', 'low_balance:'||wid||':'||a.low_since, jsonb_build_object('totalUc', total::text));
    END IF;
    -- Sending pauses once the balance is gone and this month's free sends are used; free received mail doesn't keep it going.
    IF total <= 0 AND coalesce((SELECT sent FROM billing_months WHERE workspace_id=wid AND month=this_month), 0) >= 3000 AND a.empty_since IS NULL THEN
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
-- openUc is what settling everything now would post (a refund counts as soon as it is written), and the free
-- allowances left are this month's less its charged usage, settled or not. monthCostUc is this month's cost so far;
-- monthWouldBeUc is what it would be if every hour were charged (what a free workspace's usage is worth).
CREATE OR REPLACE FUNCTION billing_position(wid text) RETURNS jsonb LANGUAGE sql STABLE AS $$
WITH cfg AS (SELECT mode AS enforcement, receive_hold FROM billing_config WHERE singleton),
a AS (SELECT coalesce(b.mode,'prepaid') AS mode, coalesce(b.balance_uc,0) AS bal, coalesce(b.promo_uc,0) AS promo,
        b.unpaid_since, coalesce(b.recharge_threshold_uc,0) AS threshold,
        coalesce(b.recharge_enabled AND b.recharge_disabled_at IS NULL AND b.recharge_pending_attempt IS NULL AND b.stripe_payment_method IS NOT NULL,false) AS can_recharge
      FROM (SELECT 1) one LEFT JOIN billing_accounts b ON b.workspace_id=wid),
-- Every month with unsettled usage, and this month (a zero row in the current hour) for the allowances.
priced AS (SELECT * FROM billing_priced(wid, ARRAY(SELECT d FROM billing_usage_hourly u
    CROSS JOIN LATERAL billing_row_deltas(u.hour, u.meter, u.rate_version, u.quantity - u.settled_quantity, u.refunds) d
    WHERE u.workspace_id=wid AND (u.quantity <> u.settled_quantity OR u.refunds <> '{}')) || ROW(date_trunc('hour', now(), 'UTC'), 'send', 1, 0)::billing_delta)),
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

-- Send meters write a send into the hour it was created in (the hour its refund goes back to), after the workspace's
-- send-meter lock (31403): a refund now writes into its own mail's hour, so one statement can touch several hour rows,
-- and with the lock two transactions never take a workspace's rows in opposite orders. Sends already queued there: they
-- all wrote the current hour's row.
CREATE OR REPLACE FUNCTION billing_meter_sends() RETURNS trigger LANGUAGE plpgsql AS $$
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
  CROSS JOIN (SELECT bill_simulated FROM billing_config WHERE singleton) cfg
  WHERE (NOT n.simulated OR cfg.bill_simulated) AND hosted_charged(n.status,n.provider_id,n.error_code)
  GROUP BY 1,2,3 ORDER BY 1,2,3
  ON CONFLICT (workspace_id,hour,meter,rate_version) DO UPDATE SET quantity=u.quantity+excluded.quantity;
  RETURN NULL;
END $$;

-- A send's charged <-> uncharged change (a cancellation, a pre-SES rejection, a validation suppression, or a later
-- charge) is written into the hour its mail was metered in, whatever its age, so it lands in that hour's month and
-- mode. It went into the current hour (or a past month's last hour) with its origin noted in refunds.
CREATE OR REPLACE FUNCTION billing_adjust_sends() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE d bigint; m text;
BEGIN
  IF NEW.simulated AND NOT (SELECT bill_simulated FROM billing_config WHERE singleton) THEN RETURN NULL; END IF;
  d := (hosted_charged(NEW.status,NEW.provider_id,NEW.error_code)::int - hosted_charged(OLD.status,OLD.provider_id,OLD.error_code)::int)
       * jsonb_array_length(NEW.to_addresses||NEW.cc_addresses||NEW.bcc_addresses);
  m := CASE WHEN EXISTS (SELECT FROM provider_pool_regions p WHERE p.feedback_topic_arn=NEW.feedback_topic_arn) THEN 'send'
    ELSE (SELECT CASE WHEN NEW.feedback_topic_arn IS NULL AND kind='shared' THEN 'send' ELSE 'byo_send' END
          FROM provider_connections WHERE workspace_id=NEW.workspace_id ORDER BY kind LIMIT 1) END;
  IF d=0 OR m IS NULL THEN RETURN NULL; END IF;
  PERFORM billing_meter_fence(NEW.workspace_id);
  PERFORM pg_advisory_xact_lock(31403, hashtext(NEW.workspace_id));
  INSERT INTO billing_usage_hourly AS u (workspace_id,hour,meter,rate_version,quantity,adjusted_at)
    VALUES (NEW.workspace_id,date_trunc('hour',NEW.created_at,'UTC'),m,1,d,now())
    ON CONFLICT (workspace_id,hour,meter,rate_version) DO UPDATE SET quantity=u.quantity+excluded.quantity, adjusted_at=excluded.adjusted_at;
  RETURN NULL;
END $$;

-- 314's billing_post, refusing a settlement by the settler before 334: one that was waiting for this migration's lock
-- and then resumed in its old code would count usage in a way billing_months doesn't. It fails, and the next run
-- settles that usage.
CREATE OR REPLACE FUNCTION billing_post(wid text, k text, src text, paid bigint, promo bigint, det jsonb, who text) RETURNS jsonb
LANGUAGE plpgsql AS $$
DECLARE a billing_accounts; eid bigint;
  credit boolean := k IN ('topup','grant','refund_release','dispute_reversal') OR (k='adjustment' AND paid+promo>0);
BEGIN
  IF k='usage' AND det ? 'rateVersion' AND NOT det ? 'usageMonth' THEN
    RAISE EXCEPTION 'usage settled by the settler before migration 334' USING ERRCODE='55000', HINT='The next settlement run settles it.';
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
