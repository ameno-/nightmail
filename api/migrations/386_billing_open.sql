SET LOCAL lock_timeout='2s';
-- Usage meter updates stay in place (HOT). Every send, refund, received message and AI decision adds to its workspace's
-- hourly row in billing_usage_hourly, and the partial index billing_usage_open (313) found unsettled rows by quantity,
-- settled_quantity and refunds: the columns each of those updates changes. So no meter update could be HOT: each wrote
-- a new row version with new entries in both indexes, and left a dead one for autovacuum, while the workspace's next
-- send waited on that row.
--
-- billing_open lists instead the workspace-hours that may hold unsettled usage. A trigger writes an hour when one of its
-- rows starts to hold some (a new row, or a settled one written again: a refund or late usage into an hour already
-- settled), and the settler deletes it once none is left. Every reader of unsettled usage (the position, the settler,
-- the mode switch, the hourly run's discovery and lag check) takes its hours from billing_open, then the same rows by
-- the same predicate as before, so what each one prices doesn't change. 387 drops the index, concurrently.
--
-- An hour with unsettled usage is never missing from billing_open:
-- - The trigger writes it in the transaction of the write that opens the hour, whatever wrote it (meters, refunds, the
--   storage day, an operator): both commit or neither does.
-- - A writer that finds the hour already listed locks it (FOR KEY SHARE) until it commits. The settler deletes an hour
--   only once it holds its row (FOR UPDATE SKIP LOCKED: it never waits, and an hour a writer holds stays for the next
--   run) and then, in a statement of its own, finds no unsettled usage there. A writer the settler didn't see waits for
--   the delete to commit and lists the hour again.
-- An hour listed with nothing left (a writer that rolled back, usage deleted by hand) costs one lookup until the
-- workspace's next settlement deletes it.
--
-- lock order: begin
-- billing_usage_hourly (SHARE ROW EXCLUSIVE, which the triggers need), then nothing else: it waits for the meter writes
-- and settlements in flight and holds new ones until it commits, so the backfill below sees every unsettled row and
-- every write after it fires the triggers. Plain reads (the position, the gate, the dashboard) go on. From here, writers
-- take billing_open after their usage row, and the settler takes it last, without waiting.
-- lock order: end
LOCK TABLE billing_usage_hourly IN SHARE ROW EXCLUSIVE MODE;

CREATE TABLE IF NOT EXISTS billing_open (
  workspace_id text NOT NULL,
  hour timestamptz NOT NULL,
  PRIMARY KEY (workspace_id, hour));

-- A usage row that starts to hold unsettled usage lists its hour, or holds the hour's listing until it commits.
CREATE OR REPLACE FUNCTION billing_open_hour() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  LOOP
    INSERT INTO billing_open (workspace_id, hour) VALUES (NEW.workspace_id, NEW.hour) ON CONFLICT DO NOTHING;
    EXIT WHEN FOUND;
    PERFORM FROM billing_open WHERE workspace_id = NEW.workspace_id AND hour = NEW.hour FOR KEY SHARE;
    EXIT WHEN FOUND;   -- not found: a settlement deleted it after the insert looked, so list it again
  END LOOP;
  RETURN NULL;
END $$;
CREATE OR REPLACE TRIGGER billing_usage_opened AFTER INSERT ON billing_usage_hourly FOR EACH ROW
  WHEN (NEW.quantity <> NEW.settled_quantity OR NEW.refunds <> '{}')
  EXECUTE FUNCTION billing_open_hour();
CREATE OR REPLACE TRIGGER billing_usage_reopened AFTER UPDATE ON billing_usage_hourly FOR EACH ROW
  WHEN ((NEW.quantity <> NEW.settled_quantity OR NEW.refunds <> '{}')
    AND ((OLD.quantity = OLD.settled_quantity AND OLD.refunds = '{}') OR (OLD.workspace_id, OLD.hour) IS DISTINCT FROM (NEW.workspace_id, NEW.hour)))
  EXECUTE FUNCTION billing_open_hour();

-- The hours open now.
INSERT INTO billing_open (workspace_id, hour)
  SELECT DISTINCT workspace_id, hour FROM billing_usage_hourly WHERE quantity <> settled_quantity OR refunds <> '{}' ORDER BY 1, 2
  ON CONFLICT DO NOTHING;

-- The settler's last step: deletes a workspace's hours before cutoff that hold no unsettled usage. The delete is its own
-- statement, so under read committed its snapshot is taken after the locks and sees every writer that held one; under
-- an older snapshot it deletes nothing.
CREATE OR REPLACE FUNCTION billing_open_prune(wid text, cutoff timestamptz) RETURNS void LANGUAGE plpgsql AS $$
DECLARE held timestamptz[];
BEGIN
  IF current_setting('transaction_isolation') <> 'read committed' THEN RETURN; END IF;
  SELECT array_agg(hour) INTO held FROM (SELECT hour FROM billing_open WHERE workspace_id=wid AND hour < cutoff ORDER BY hour FOR UPDATE SKIP LOCKED) h;
  DELETE FROM billing_open o WHERE o.workspace_id=wid AND o.hour = ANY (held)
    AND NOT EXISTS (SELECT FROM billing_usage_hourly u WHERE u.workspace_id=wid AND u.hour=o.hour AND (u.quantity <> u.settled_quantity OR u.refunds <> '{}'));
END $$;

-- 367's settler: its hours from billing_open, and the hours it leaves with nothing unsettled deleted.
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
  WITH open AS (SELECT u.hour, u.meter, u.rate_version, u.quantity, u.settled_quantity, u.refunds FROM billing_open o
      JOIN billing_usage_hourly u ON u.workspace_id=o.workspace_id AND u.hour=o.hour
      WHERE o.workspace_id=wid AND o.hour < cutoff AND (u.quantity <> u.settled_quantity OR u.refunds <> '{}')
        AND (u.hour < cut OR EXISTS (SELECT FROM jsonb_object_keys(u.refunds) k WHERE to_timestamp(ltrim(k, 's')::bigint) < cut))
      ORDER BY u.hour, u.meter, u.rate_version FOR UPDATE OF u SKIP LOCKED),
    part AS (SELECT o.*, CASE WHEN o.hour < cut THEN o.refunds ELSE (SELECT jsonb_object_agg(k, v) FROM jsonb_each(o.refunds) x(k, v)
               WHERE to_timestamp(ltrim(k, 's')::bigint) < cut) END AS taken FROM open o),
    closed AS (UPDATE billing_usage_hourly u
      SET settled_quantity = CASE WHEN r.hour < cut THEN r.quantity ELSE r.settled_quantity + (SELECT sum(v::bigint) FROM jsonb_each_text(r.taken) x(k, v)) END,
          refunds = CASE WHEN r.hour < cut THEN '{}' ELSE r.refunds - ARRAY(SELECT jsonb_object_keys(r.taken)) END
      FROM part r WHERE u.workspace_id=wid AND u.hour=r.hour AND u.meter=r.meter AND u.rate_version=r.rate_version
      RETURNING r.hour, r.meter, r.rate_version, u.settled_quantity - r.settled_quantity AS delta, r.taken)
  SELECT count(DISTINCT (c.hour, c.meter, c.rate_version))::int, array_agg(d ORDER BY d.hour, d.meter) INTO n_rows, deltas
    FROM closed c CROSS JOIN LATERAL billing_row_deltas(c.hour, c.meter, c.rate_version, c.delta, c.taken) d;
  IF coalesce(n_rows, 0) = 0 THEN PERFORM billing_open_prune(wid, cutoff); RETURN jsonb_build_object('entries', 0); END IF;
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
  PERFORM billing_open_prune(wid, cutoff);
  RETURN jsonb_build_object('entries', n_rows, 'costUc', (CASE WHEN charged_any THEN money_total ELSE would_be_total END)::text,
    'charged', charged_any, 'entryId', ids[1], 'entryIds', to_jsonb(ids));
END $$;

-- 380's position: its unsettled rows through billing_open.
CREATE OR REPLACE FUNCTION billing_position(wid text) RETURNS jsonb LANGUAGE sql STABLE AS $$
WITH cfg AS (SELECT mode AS enforcement, receive_hold FROM billing_config WHERE singleton),
a AS (SELECT coalesce(b.mode,'prepaid') AS mode, coalesce(b.balance_uc,0) AS bal, coalesce(b.promo_uc,0) AS promo,
        b.unpaid_since, coalesce(b.recharge_threshold_uc,0) AS threshold,
        coalesce(b.recharge_enabled AND b.recharge_disabled_at IS NULL AND b.recharge_pending_attempt IS NULL AND b.stripe_payment_method IS NOT NULL,false) AS can_recharge
      FROM (SELECT 1) one LEFT JOIN billing_accounts b ON b.workspace_id=wid),
-- Every month with unsettled usage, and this month (a zero row in the current hour) for the allowances.
priced AS (SELECT * FROM billing_priced(wid, ARRAY(SELECT c FROM billing_classify(wid, ARRAY(SELECT d FROM billing_open o
    JOIN billing_usage_hourly u ON u.workspace_id=o.workspace_id AND u.hour=o.hour
    CROSS JOIN LATERAL billing_row_deltas(u.hour, u.meter, u.rate_version, u.quantity - u.settled_quantity, u.refunds) d
    WHERE o.workspace_id=wid AND (u.quantity <> u.settled_quantity OR u.refunds <> '{}')), false) c)
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

-- 314's mode switch and its loop over every workspace with unsettled usage, through billing_open.
CREATE OR REPLACE FUNCTION billing_settle_switch(wid text) RETURNS jsonb LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO billing_accounts(workspace_id) VALUES (wid) ON CONFLICT DO NOTHING;
  PERFORM 1 FROM billing_accounts WHERE workspace_id=wid FOR UPDATE;
  PERFORM 1 FROM billing_open o JOIN billing_usage_hourly u ON u.workspace_id=o.workspace_id AND u.hour=o.hour
    WHERE o.workspace_id=wid AND (u.quantity <> u.settled_quantity OR u.refunds <> '{}')
    ORDER BY u.hour, u.meter, u.rate_version FOR UPDATE OF u;
  RETURN billing_settle(wid, 'infinity');
END $$;

CREATE OR REPLACE FUNCTION billing_settle_all() RETURNS int LANGUAGE plpgsql AS $$
DECLARE w text; n int := 0;
BEGIN
  PERFORM pg_advisory_xact_lock(31401, 0);
  FOR w IN SELECT DISTINCT o.workspace_id FROM billing_open o WHERE EXISTS (SELECT FROM billing_usage_hourly u
      WHERE u.workspace_id=o.workspace_id AND u.hour=o.hour AND (u.quantity <> u.settled_quantity OR u.refunds <> '{}')) ORDER BY 1 LOOP
    PERFORM billing_settle_switch(w);
    n := n + 1;
  END LOOP;
  RETURN n;
END $$;