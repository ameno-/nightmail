SET LOCAL lock_timeout='2s';
-- A workspace is prepaid or exempt, and which one follows from the free flags alone. The 'invoiced' mode is gone:
-- its usage was taken from the balance, but nothing gated, held, notified, wrote off or invoiced it, so the balance
-- just went negative. paid_mode only remembered prepaid or invoiced while a free flag was on, so it goes too.
-- Enterprise invoicing, if it comes, is a feature (an exposure limit and a monthly invoice), not a mode.
--
-- An invoiced account, or a free one that would become invoiced when its flag ends, stops the migration instead of
-- being converted: prepaid would gate and hold a debt nobody agreed to, exempt would forgive it. Move each one to
-- prepaid or exempt with set-billing-mode.ts, then migrate again. The table lock comes first, so no row can become
-- invoiced between the check and the change.
LOCK TABLE billing_accounts IN ACCESS EXCLUSIVE MODE;
DO $$
DECLARE n int := (SELECT count(*) FROM billing_accounts WHERE mode='invoiced' OR paid_mode='invoiced');
BEGIN
  IF n > 0 THEN
    RAISE EXCEPTION '% billing account(s) are invoiced', n USING
      HINT='Move each to prepaid or exempt with scripts/set-billing-mode.ts, then migrate again: SELECT workspace_id, mode, paid_mode FROM billing_accounts WHERE mode=''invoiced'' OR paid_mode=''invoiced''';
  END IF;
END $$;
ALTER TABLE billing_accounts DROP CONSTRAINT billing_accounts_mode_check,
  ADD CONSTRAINT billing_accounts_mode_check CHECK (mode IN ('prepaid','exempt')),
  DROP COLUMN paid_mode;

-- 314's sync: a workspace that is not free is prepaid.
CREATE OR REPLACE FUNCTION billing_free_sync(wid text) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE s jsonb; old text; target text; m text;
BEGIN
  IF (billing_free_state(wid)->>'free')::boolean THEN INSERT INTO billing_accounts(workspace_id) VALUES (wid) ON CONFLICT DO NOTHING; END IF;
  SELECT mode INTO old FROM billing_accounts WHERE workspace_id=wid FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('free', false, 'via', null, 'until', null, 'mode', 'prepaid'); END IF;
  s := billing_free_state(wid);
  target := CASE WHEN (s->>'free')::boolean THEN 'exempt' ELSE 'prepaid' END;
  IF target <> old AND (SELECT mode FROM billing_config WHERE singleton) <> 'off' THEN
    PERFORM pg_advisory_xact_lock(31402, hashtext(wid));
    PERFORM billing_settle_switch(wid);
  END IF;
  UPDATE billing_accounts SET mode=target, free_via=s->>'via', updated_at=now()
    WHERE workspace_id=wid AND (mode, free_via) IS DISTINCT FROM (target, s->>'via');
  SELECT mode INTO m FROM billing_accounts WHERE workspace_id=wid;
  RETURN s || jsonb_build_object('mode', m);
END $$;

-- 302's mode setter without invoiced: exempt turns the workspace's free flag on with no end, prepaid turns it off (a
-- free owner's account still keeps the workspace free). Returns the previous mode with the new state, or NULL when
-- the workspace doesn't exist.
CREATE OR REPLACE FUNCTION billing_set_mode(wid text, m text, why text, who text) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE old text;
BEGIN
  IF m IS NULL OR m NOT IN ('prepaid','exempt') THEN RAISE EXCEPTION 'unknown billing mode %', m USING ERRCODE='22023'; END IF;
  IF NOT EXISTS (SELECT FROM workspaces WHERE id=wid) THEN RETURN NULL; END IF;
  SELECT mode INTO old FROM billing_accounts WHERE workspace_id=wid FOR UPDATE;
  RETURN jsonb_build_object('old', coalesce(old,'prepaid')) || billing_set_workspace_free(wid, m='exempt', why, NULL, who);
END $$;
