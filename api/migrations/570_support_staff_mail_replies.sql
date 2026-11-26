SET LOCAL lock_timeout = '2s';
-- Staff email, both ways (src/support-staff-mail.ts). Expand-only: the new columns are nullable or defaulted, and the
-- looser staff check admits everything the deployed code writes.
--
-- A reply to a staff email, from a verified staff address, becomes an internal note on its ticket's conversation: a staff
-- note (kind note, never delivered) whose email_from is the address it came from. The note is by its operator when the
-- address is an operator's, or by the team address alone (TICKET_TO), so a staff row now names its staff member or the
-- address it came by email from.
ALTER TABLE support_messages ADD COLUMN IF NOT EXISTS email_from text
  CHECK (email_from IS NULL OR (author = 'staff' AND kind = 'note' AND delivery IS NULL AND length(email_from) BETWEEN 3 AND 320));
DO $$
DECLARE c record;
BEGIN
  FOR c IN SELECT conname FROM pg_constraint WHERE conrelid = 'support_messages'::regclass AND contype = 'c'
      AND pg_get_constraintdef(oid) LIKE '%staff_user_id IS NOT NULL%' AND pg_get_constraintdef(oid) NOT LIKE '%email_from%' LOOP
    EXECUTE format('ALTER TABLE support_messages DROP CONSTRAINT %I', c.conname);
  END LOOP;
END $$;
ALTER TABLE support_messages DROP CONSTRAINT IF EXISTS support_messages_staff_author;
ALTER TABLE support_messages ADD CONSTRAINT support_messages_staff_author CHECK ((author = 'staff') = (staff_user_id IS NOT NULL OR email_from IS NOT NULL));
-- Replies are matched to their staff thread by the thread Nightmail filed them in, and that thread's own Message-IDs.
CREATE INDEX IF NOT EXISTS support_staff_threads_thread ON support_staff_threads (thread_id) WHERE thread_id IS NOT NULL;

-- A staff email the support platform could not send: each failed try is reported (attempts, the last error's code), and
-- after three it counts as not sent (failed_at) on Glass's support tile until it goes.
ALTER TABLE support_staff_emails
  ADD COLUMN IF NOT EXISTS attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  ADD COLUMN IF NOT EXISTS last_error text CHECK (last_error ~ '^[A-Z][A-Z0-9_]{0,63}$'),
  ADD COLUMN IF NOT EXISTS failed_at timestamptz;
