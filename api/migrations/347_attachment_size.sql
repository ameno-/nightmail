SET LOCAL lock_timeout='1s';
-- Attachments may be up to 25 MiB (SEND_LIMITS.attachmentBytes): the largest that, base64-encoded with MIME line
-- breaks, still fits Amazon SES's 40 MB message beside a body. The check only widens, so existing rows pass; NOT VALID
-- then VALIDATE keeps the table's write lock to the swap, not the scan.
ALTER TABLE sending_attachments DROP CONSTRAINT sending_attachments_size_check,
  ADD CONSTRAINT sending_attachments_size_check CHECK (size > 0 AND size <= 26214400) NOT VALID;
ALTER TABLE sending_attachments VALIDATE CONSTRAINT sending_attachments_size_check;
