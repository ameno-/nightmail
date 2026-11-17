SET LOCAL lock_timeout='2s';
-- Billing step 1 of 3 (code review billing-1, billing-2): whether usage is charged becomes a fact about the hour it was
-- metered in, recorded as an append-only history. Nothing reads it yet: today's settler still prices by the mode when it
-- runs. The next step prices each hour from it. This migration records workspaces; 320 records the installation, in
-- its own transaction, so neither holds one of billing_accounts and billing_config while it waits for the other.
--
-- Only billing_accounts is locked (for its trigger), first and alone, so this waits for a settlement or money post in
-- flight and then waits for nothing else.
LOCK TABLE billing_accounts IN SHARE ROW EXCLUSIVE MODE;

-- When charging started and stopped: for the installation (workspace_id NULL: billing_config.mode is 'enforce') and for
-- a workspace (billing_accounts.mode is 'prepaid'). An hour is charged when both are. A change takes effect on an hour
-- boundary, rounded in the customer's favour: one that stops charging applies to the hour it is made in, one that starts
-- charging from the next hour.
CREATE TABLE IF NOT EXISTS billing_mode_changes (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,   -- decision order
  workspace_id text,                                     -- NULL: the installation
  charged boolean NOT NULL,
  effective_hour timestamptz NOT NULL CHECK (effective_hour = date_trunc('hour', effective_hour, 'UTC')),
  decided_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  actor text NOT NULL,
  reason text);
CREATE INDEX IF NOT EXISTS billing_mode_changes_scope ON billing_mode_changes (workspace_id, id);
CREATE OR REPLACE FUNCTION billing_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE='42501'; END $$;
CREATE OR REPLACE TRIGGER billing_mode_changes_append_only BEFORE UPDATE OR DELETE ON billing_mode_changes FOR EACH ROW EXECUTE FUNCTION billing_append_only();
CREATE OR REPLACE TRIGGER billing_mode_changes_no_truncate BEFORE TRUNCATE ON billing_mode_changes FOR EACH STATEMENT EXECUTE FUNCTION billing_append_only();

-- Whether usage metered in hour h is charged: the latest decision in effect by then, for the installation (none: not
-- charged) and for the workspace (none: prepaid, charged).
CREATE OR REPLACE FUNCTION billing_charged(wid text, h timestamptz) RETURNS boolean LANGUAGE sql STABLE PARALLEL SAFE AS $$
  SELECT coalesce((SELECT charged FROM billing_mode_changes WHERE workspace_id IS NULL AND effective_hour <= h ORDER BY id DESC LIMIT 1), false)
     AND coalesce((SELECT charged FROM billing_mode_changes WHERE workspace_id = wid AND effective_hour <= h ORDER BY id DESC LIMIT 1), true)
$$;

-- Records a change of the installation's (wid NULL) or a workspace's charging when it differs from the latest decision.
-- Its callers are triggers on the mode columns, so they run under the row lock that orders those changes (the account
-- row, or billing_config's). A caller may name itself with set_config('billing.actor' / 'billing.reason', ..., true).
CREATE OR REPLACE FUNCTION billing_mode_note(wid text, want boolean, actor text, reason text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE latest boolean; h timestamptz := date_trunc('hour', clock_timestamp(), 'UTC');
BEGIN
  IF wid IS NULL THEN SELECT charged INTO latest FROM billing_mode_changes WHERE workspace_id IS NULL ORDER BY id DESC LIMIT 1;
  ELSE SELECT charged INTO latest FROM billing_mode_changes WHERE workspace_id = wid ORDER BY id DESC LIMIT 1; END IF;
  IF want = coalesce(latest, wid IS NOT NULL) THEN RETURN; END IF;
  INSERT INTO billing_mode_changes(workspace_id, charged, effective_hour, actor, reason)
    VALUES (wid, want, CASE WHEN want THEN h + interval '1 hour' ELSE h END,
      coalesce(nullif(current_setting('billing.actor', true), ''), actor, 'system'), coalesce(nullif(current_setting('billing.reason', true), ''), reason));
END $$;
-- Every write of a workspace's mode is recorded: the free-flag sync, the hourly expiry sweep, an operator's SQL.
CREATE OR REPLACE FUNCTION billing_accounts_mode() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM billing_mode_note(NEW.workspace_id, NEW.mode = 'prepaid', CASE WHEN NEW.mode = 'exempt' AND NEW.free_via = 'workspace' THEN NEW.free_by END,
    CASE WHEN NEW.mode = 'exempt' THEN 'free (' || coalesce(NEW.free_via, 'set directly') || ')' ELSE 'not free' END);
  RETURN NULL;
END $$;
CREATE OR REPLACE TRIGGER billing_accounts_mode AFTER INSERT OR UPDATE OF mode ON billing_accounts FOR EACH ROW EXECUTE FUNCTION billing_accounts_mode();

-- The state now, as if it had always been so: every exempt workspace not charged (a workspace with no history is
-- prepaid). What happened before this is settled already, and the next step settles and freezes it before it prices any
-- hour from this history. A workspace is written only while it has no history yet.
INSERT INTO billing_mode_changes(workspace_id, charged, effective_hour, actor, reason)
  SELECT workspace_id, false, '-infinity', 'migration', 'exempt at 318' FROM billing_accounts a
  WHERE mode = 'exempt' AND NOT EXISTS (SELECT FROM billing_mode_changes m WHERE m.workspace_id = a.workspace_id) ORDER BY workspace_id;
