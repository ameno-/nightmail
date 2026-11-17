SET LOCAL lock_timeout='2s';
-- Billing step 1 of 3, the installation's half of 318's history: every write of billing_config.mode is recorded by a
-- trigger, whichever version of set-billing-enforcement (or an operator's SQL) makes it. Own transaction, locking only
-- billing_config: it waits for a mode change in flight to commit, so the state below includes it, and any change after
-- it fires the trigger. It holds no account lock, so it can't close a cycle with the enforcement script (config row,
-- then accounts) and the drift check (config) as one migration taking both did.
LOCK TABLE billing_config IN SHARE ROW EXCLUSIVE MODE;

CREATE OR REPLACE FUNCTION billing_config_mode() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM billing_mode_note(NULL, NEW.mode = 'enforce', NULL, 'billing ' || NEW.mode);
  RETURN NULL;
END $$;
CREATE OR REPLACE TRIGGER billing_config_mode AFTER UPDATE OF mode ON billing_config FOR EACH ROW EXECUTE FUNCTION billing_config_mode();

-- The state now, as if it had always been so: charged if enforced. Written only while the installation has no history.
INSERT INTO billing_mode_changes(workspace_id, charged, effective_hour, actor, reason)
  SELECT NULL, true, '-infinity', 'migration', 'enforced at 320'
  FROM billing_config WHERE singleton AND mode = 'enforce' AND NOT EXISTS (SELECT FROM billing_mode_changes WHERE workspace_id IS NULL);
