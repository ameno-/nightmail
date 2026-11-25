-- When the write that stored a receipt's message committed (inboxes.ts storedAt and processingMs). The store functions
-- mark a receipt processed with now(), the start of their statement, so a slow write went uncounted; a constraint
-- trigger deferred to the commit stamps committed_at there, with clock_timestamp(), on every path that marks a receipt
-- processed. A new nullable column: metadata only, and unindexed, so the stamp's update can stay on its page. The
-- update leaves status alone, so the trigger never fires itself, and mail_receipt_settle_fence only watches pending to failed.
SET LOCAL lock_timeout = '2s';
ALTER TABLE mail_receipts ADD COLUMN IF NOT EXISTS committed_at timestamptz;
CREATE OR REPLACE FUNCTION mail_receipt_committed_at() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE mail_receipts SET committed_at = clock_timestamp()
    WHERE workspace_id = NEW.workspace_id AND ses_message_id = NEW.ses_message_id AND status = 'processed';
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS mail_receipt_committed_at ON mail_receipts;
CREATE CONSTRAINT TRIGGER mail_receipt_committed_at AFTER UPDATE OF status ON mail_receipts
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  WHEN (NEW.status = 'processed' AND OLD.status IS DISTINCT FROM 'processed')
  EXECUTE FUNCTION mail_receipt_committed_at();
