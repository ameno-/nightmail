SET LOCAL lock_timeout='2s';
-- Everything about an API key is edited on the same secret (updateApiKey), its expiry included: a workspace key can now
-- end at a chosen time, like a key limited to addresses or an inbox already could (mailbox_keys.expires_at). Null: it
-- never expires. Authentication, long polls, key administration, dispatch and SMTP sign-in read it on every use.
ALTER TABLE api_keys ADD COLUMN expires_at timestamptz;

-- The gateway drops a send-only key's cached logins and open sessions when its expiry changes, as when it is revoked
-- or narrowed (migration 346), and when a key limited to addresses becomes an inbox key or back (SMTP refuses those).
DROP TRIGGER protocol_key_changed ON api_keys;
CREATE TRIGGER protocol_key_changed AFTER UPDATE OF revoked_at,permissions,domains,expires_at ON api_keys FOR EACH ROW
 WHEN (OLD.revoked_at IS DISTINCT FROM NEW.revoked_at OR OLD.permissions IS DISTINCT FROM NEW.permissions OR OLD.domains IS DISTINCT FROM NEW.domains OR OLD.expires_at IS DISTINCT FROM NEW.expires_at)
 EXECUTE FUNCTION protocol_key_changed();
DROP TRIGGER protocol_key_changed ON mailbox_keys;
CREATE TRIGGER protocol_key_changed AFTER UPDATE OF revoked_at,permissions,mailbox_ids,expires_at,inbox_id ON mailbox_keys FOR EACH ROW
 WHEN (OLD.revoked_at IS DISTINCT FROM NEW.revoked_at OR OLD.permissions IS DISTINCT FROM NEW.permissions OR OLD.mailbox_ids IS DISTINCT FROM NEW.mailbox_ids OR OLD.expires_at IS DISTINCT FROM NEW.expires_at OR OLD.inbox_id IS DISTINCT FROM NEW.inbox_id)
 EXECUTE FUNCTION protocol_key_changed();

-- A key for one expiring agent inbox that a writer didn't name as an inbox key (create_managed_inbox, inbox connections)
-- became one because it ended when the inbox did: its expiry is the inbox's end exactly. A key for addresses that a
-- person gives its own expiry stays a key for addresses.
CREATE OR REPLACE FUNCTION mailbox_key_inbox() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.inbox_id IS NULL AND jsonb_typeof(NEW.mailbox_ids) = 'array' AND jsonb_array_length(NEW.mailbox_ids) = 1 THEN
    SELECT b.id INTO NEW.inbox_id FROM mailboxes b WHERE b.workspace_id = NEW.workspace_id AND b.id = NEW.mailbox_ids->>0 AND b.kind = 'inbox'
      AND (NEW.expires_at = b.delete_after OR b.create_request->>'type' = 'persistent');
  END IF;
  RETURN NEW;
END $$;
