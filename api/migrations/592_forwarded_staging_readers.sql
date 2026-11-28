SET LOCAL lock_timeout = '2s';

-- A staged forwarded copy is read by unsettled receipts and by held holds, which replay into receipts. 591 looked at
-- neither before queuing its deletion, so a stored sibling deleted the bytes a held recipient still needed. This is the
-- one rule for every writer that can leave a copy unread: queue its deletion only when nothing reads it any more.
CREATE OR REPLACE FUNCTION mail_forwarded_staging_drop(p_workspace text, p_message text, p_region text, p_key text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF p_key IS NULL THEN RETURN; END IF;
  -- Two transactions that each end one of a copy's readers would each still see the other's, and neither would delete
  -- it. The lock makes the second wait for the first to commit, and its check below then reads what that one left.
  PERFORM pg_advisory_xact_lock(hashtextextended(p_key, 0));
  INSERT INTO jobs(id,type,workspace_id,payload) SELECT row_id('job'),'mail.deleteObjects',p_workspace,
    jsonb_build_object('region',p_region,'bucket','local:','keys',jsonb_build_array(p_key))
    WHERE NOT EXISTS(SELECT FROM mail_receipts WHERE workspace_id=p_workspace AND ses_message_id=p_message AND status IN ('pending','held') AND notification->>'stagingKey'=p_key)
      AND NOT EXISTS(SELECT FROM mail_receipt_holds WHERE bucket='local:' AND ses_message_id=p_message AND status='held' AND notification->>'stagingKey'=p_key);
END $$;

CREATE OR REPLACE FUNCTION mail_forwarded_staging_delete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM mail_forwarded_staging_drop(NEW.workspace_id,NEW.ses_message_id,NEW.region,NEW.notification->>'stagingKey');
  RETURN NULL;
END $$;

-- A hold ends when its replay releases it or finds it expired. Its receipts may read this copy, another or none.
CREATE OR REPLACE FUNCTION mail_forwarded_hold_staging_delete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM mail_forwarded_staging_drop(NEW.binding_workspace,NEW.ses_message_id,NEW.region,NEW.notification->>'stagingKey');
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS mail_forwarded_hold_staging_delete ON mail_receipt_holds;
CREATE TRIGGER mail_forwarded_hold_staging_delete AFTER UPDATE OF status ON mail_receipt_holds FOR EACH ROW
  WHEN (NEW.bucket = 'local:' AND NEW.status <> 'held' AND OLD.status = 'held')
  EXECUTE FUNCTION mail_forwarded_hold_staging_delete();
