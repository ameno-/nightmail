SET LOCAL lock_timeout='2s';
-- Billing step 1 of 3 (code review billing-1, -2, -3): whether usage is charged becomes a fact about the hour it was
-- metered in, and a send's refund is written into that hour. Today's settler still prices by the mode when it runs and
-- ignores the history; the next step prices from it.
--
-- Locks, in the order the writers take them: billing_accounts (the settler and every money post lock an account first),
-- then billing_config (set-billing-enforcement locks its row and only then settles; the storage day and the drift check
-- touch no account before it). A writer already holding one finishes first; the others wait here until this commits.
LOCK TABLE billing_accounts IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE billing_config IN SHARE ROW EXCLUSIVE MODE;

-- Append-only: when charging started and stopped, for the installation (workspace_id NULL: billing_config.mode is
-- 'enforce') and for a workspace (billing_accounts.mode is 'prepaid'). An hour is charged when both are. A change takes
-- effect on an hour boundary, rounded in the customer's favour: one that stops charging applies to the hour it is made
-- in, one that starts charging from the next hour. Settlement only takes closed hours, so no settled hour changes mode.
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
DROP TRIGGER IF EXISTS billing_mode_changes_append_only ON billing_mode_changes;
CREATE TRIGGER billing_mode_changes_append_only BEFORE UPDATE OR DELETE ON billing_mode_changes FOR EACH ROW EXECUTE FUNCTION billing_append_only();

-- Whether usage metered in hour h is charged: the latest decision in effect by then, for the installation (none: not
-- charged) and for the workspace (none: prepaid, charged).
CREATE OR REPLACE FUNCTION billing_charged(wid text, h timestamptz) RETURNS boolean LANGUAGE sql STABLE PARALLEL SAFE AS $$
  SELECT coalesce((SELECT charged FROM billing_mode_changes WHERE workspace_id IS NULL AND effective_hour <= h ORDER BY id DESC LIMIT 1), false)
     AND coalesce((SELECT charged FROM billing_mode_changes WHERE workspace_id = wid AND effective_hour <= h ORDER BY id DESC LIMIT 1), true)
$$;

-- Records a change of the installation's or a workspace's charging when its latest decision differs. Every mode write
-- goes through the two triggers below, so the history can't miss one (the script, the free-flag sync, the hourly
-- expiry sweep, an operator's SQL). Callers may name themselves with set_config('billing.actor' / 'billing.reason', ..., true).
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
CREATE OR REPLACE FUNCTION billing_accounts_mode() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM billing_mode_note(NEW.workspace_id, NEW.mode = 'prepaid', CASE WHEN NEW.mode = 'exempt' AND NEW.free_via = 'workspace' THEN NEW.free_by END,
    CASE WHEN NEW.mode = 'exempt' THEN 'free (' || coalesce(NEW.free_via, 'set directly') || ')' ELSE 'not free' END);
  RETURN NULL;
END $$;
CREATE OR REPLACE FUNCTION billing_config_mode() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM billing_mode_note(NULL, NEW.mode = 'enforce', NULL, 'billing ' || NEW.mode);
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS billing_accounts_mode ON billing_accounts;
CREATE TRIGGER billing_accounts_mode AFTER INSERT OR UPDATE OF mode ON billing_accounts FOR EACH ROW EXECUTE FUNCTION billing_accounts_mode();
DROP TRIGGER IF EXISTS billing_config_mode ON billing_config;
CREATE TRIGGER billing_config_mode AFTER UPDATE OF mode ON billing_config FOR EACH ROW EXECUTE FUNCTION billing_config_mode();

-- The history before this migration, from what is known now. Nothing in it can make the next step charge more than
-- today's settler did, or give back money for mail that was never charged:
-- - The installation: charged from the hour after enforcement last started (billing_config.enforced_at); before that
--   it was off or in shadow, as on a new installation.
-- - An exempt workspace: uncharged for all of its past.
-- - A prepaid workspace that settled usage uncharged while prepaid now (exempt for a while, or before enforcement):
--   uncharged until the end of its last uncharged settlement, charged from there.
-- - Any other workspace: prepaid, charged whenever the installation was.
-- Re-running it adds nothing: each scope is written only while it has no history yet.
INSERT INTO billing_mode_changes(workspace_id, charged, effective_hour, actor, reason)
  SELECT NULL, true, date_trunc('hour', coalesce(enforced_at, now()), 'UTC') + interval '1 hour', 'migration', 'enforced before 318'
  FROM billing_config WHERE singleton AND mode = 'enforce' AND NOT EXISTS (SELECT FROM billing_mode_changes WHERE workspace_id IS NULL);
INSERT INTO billing_mode_changes(workspace_id, charged, effective_hour, actor, reason)
  SELECT a.workspace_id, c.charged, c.h, 'migration', c.why FROM billing_accounts a
  CROSS JOIN LATERAL (SELECT max((l.detail->>'to')::timestamptz) AS till FROM billing_ledger l
    WHERE l.workspace_id = a.workspace_id AND l.kind = 'usage' AND l.detail->>'charged' = 'false' AND a.mode = 'prepaid') f
  CROSS JOIN LATERAL (VALUES (1, false, '-infinity'::timestamptz, CASE WHEN a.mode = 'exempt' THEN 'exempt before 318' ELSE 'settled uncharged before 318' END),
                             (2, true, date_trunc('hour', f.till, 'UTC'), 'prepaid before 318')) c(n, charged, h, why)
  WHERE (a.mode = 'exempt' AND c.n = 1 OR f.till IS NOT NULL) AND NOT EXISTS (SELECT FROM billing_mode_changes m WHERE m.workspace_id = a.workspace_id)
  ORDER BY a.workspace_id, c.n;

-- A send's charged <-> uncharged change (a cancellation, a pre-SES rejection, a validation suppression, or a later
-- charge) is written into the hour its mail was metered in (sending_emails.created_at's hour, the hour
-- billing_meter_sends wrote it into), so it lands in that hour's bucket, month and mode, whatever its age. It went into
-- the current hour (or a past month's last hour) with its origin noted in billing_usage_hourly.refunds, which nothing
-- writes now; today's settler prices a late write into a settled hour as that hour's own refund (its charged units,
-- after its uncharged ones), so it gives back exactly what it gave back before. A statement that changes many sends
-- writes into as many hours, in the order hosted_adjust_usage (230) already writes hosted_usage_hourly for those rows.
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
  INSERT INTO billing_usage_hourly AS u (workspace_id,hour,meter,rate_version,quantity)
    VALUES (NEW.workspace_id,date_trunc('hour',NEW.created_at,'UTC'),m,1,d)
    ON CONFLICT (workspace_id,hour,meter,rate_version) DO UPDATE SET quantity=u.quantity+excluded.quantity;
  RETURN NULL;
END $$;
