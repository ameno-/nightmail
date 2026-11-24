SET LOCAL lock_timeout='2s';
-- Rate version 4 (Ryan, 2026-11-24): 20,000 received emails free each UTC month, up from 5,000. Sent stays 5,000 free,
-- and the price beyond either allowance stays $0.20 per 1,000. AI decisions (free since version 3) and storage don't
-- change: billing_rate_uc prices decisions at $0 for version 3 and later, so it needs no change.
--
-- A rate version prices whole UTC months (367), so version 4 can't start mid-month: it prices November 2026, the month
-- this ships in, and every month after it, in place of version 3. Months before it keep version 1: no earlier month is
-- repriced or charged again. billing_settle and billing_position read each month's allowance from billing_rates_in, so
-- unsettled usage and the free received left this month follow it at once; nothing else stores the allowance
-- (billing_accounts.free_received_used is a count, not a limit).
--
-- November's received mail settled so far was priced against 5,000 free. As 367 did, each month from November 2026
-- that posted more than it costs under version 4 is posted once here at its new cost: what its 5,001st to 20,000th
-- received messages were charged comes back to the balance as a usage row for that month, promotional credit first up
-- to what promo paid for it. Run again, it posts nothing.
--
-- lock order: begin
-- billing_accounts (EXCLUSIVE), then what a settlement takes after an account (the ledger, credit lots), as 367: it
-- waits for every settlement and money post in flight and holds new ones until it commits, so each month it posts is
-- read after its last settlement at the old allowance. Meter writes and plain reads (the position, the gate, the
-- dashboard) go on.
-- lock order: end
LOCK TABLE billing_accounts IN EXCLUSIVE MODE;

-- Each month's rates (367): version 4 from November 2026, version 1 before it.
CREATE OR REPLACE FUNCTION billing_rates_in(month date) RETURNS billing_rates LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT CASE WHEN month >= DATE '2026-11-01' THEN ROW(4, 5000, 20000)::billing_rates ELSE ROW(1, 3000, 3000)::billing_rates END
$$;

-- Months from November 2026 settled against 5,000 received free, posted once at their version 4 cost. The usage row
-- says what came back: the received messages between the two allowances, as negative payable units.
DO $$
DECLARE b billing_months; r billing_rates; cost bigint; money bigint; take bigint; v bigint;
BEGIN
  FOR b IN SELECT * FROM billing_months WHERE month >= DATE '2026-11-01' ORDER BY workspace_id, month LOOP
    r := billing_rates_in(b.month); cost := billing_month_cost(b.month, b.sent, b.received, b.other_uc);
    CONTINUE WHEN cost >= b.posted_uc;
    money := cost - b.posted_uc; take := -least(b.promo_uc, -money);
    v := greatest(0, b.received - r.free_received) - greatest(0, b.received - 5000);
    PERFORM billing_post(b.workspace_id, 'usage', 'usage:'||b.workspace_id||':'||to_char(b.month, 'YYYY-MM')||':rates-'||r.version, -(money - take), -take,
      jsonb_build_object('meters', jsonb_build_object('receive', jsonb_build_object('quantity', 0, 'payable', v, 'costUc', v * 20000)),
        'costUc', money::text, 'charged', true, 'usageMonth', to_char(b.month, 'YYYY-MM'), 'rateVersion', r.version,
        'repriced', jsonb_build_object('freeSent', r.free_sent, 'freeReceived', r.free_received)), 'system');
    UPDATE billing_months SET posted_uc = cost, promo_uc = promo_uc + take WHERE workspace_id = b.workspace_id AND month = b.month;
  END LOOP;
  -- The month counters of the settler before 333's, for what still reads them.
  UPDATE billing_accounts a SET month_spend_uc = billing_month_cost(m.month, m.sent + m.uncharged_sent, m.received + m.uncharged_received, m.other_uc + m.uncharged_other_uc)
    FROM billing_months m WHERE m.workspace_id = a.workspace_id AND m.month = a.free_month AND a.free_month >= DATE '2026-11-01';
END $$;
