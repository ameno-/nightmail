SET LOCAL lock_timeout = '2s';

-- A forwarded message (bucket local:) waits for ingest in the runtime's own object storage, which has no lifecycle rule
-- like the one that expires SES's staged copy, and those bytes still hold any Bcc line. Receipts settle in the ingest
-- handler, in the store functions and in lost-receipt recovery, so the deletion is queued here, in the transaction of
-- whichever write settles one. A processed or failed receipt never reads that copy again: a reopen brings its own.
CREATE OR REPLACE FUNCTION mail_forwarded_staging_delete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO jobs(id,type,workspace_id,payload) VALUES(row_id('job'),'mail.deleteObjects',NEW.workspace_id,
    jsonb_build_object('region',NEW.region,'bucket',NEW.bucket,'keys',jsonb_build_array(NEW.notification->>'stagingKey')));
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS mail_forwarded_staging_delete ON mail_receipts;
CREATE TRIGGER mail_forwarded_staging_delete AFTER UPDATE OF status ON mail_receipts FOR EACH ROW
  WHEN (NEW.bucket = 'local:' AND NEW.status IN ('processed','failed') AND OLD.status NOT IN ('processed','failed'))
  EXECUTE FUNCTION mail_forwarded_staging_delete();
