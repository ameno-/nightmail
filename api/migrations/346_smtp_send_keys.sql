SET LOCAL lock_timeout='2s';
-- Send-only SMTP (protocol-relay.ts): an app signs in to the mail gateway with a send-only API key, limited to sender
-- domains (api_keys) or to receiving addresses (mailbox_keys). The gateway keys such a session by the key's ID, as it
-- keys an app password's by its inbox, and drops its cached logins and open sessions when bane_protocol_auth names it.
-- Revoking a key, or changing what it may send, notifies; last_used_at and name changes don't.
CREATE FUNCTION protocol_key_changed() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 PERFORM pg_notify('bane_protocol_auth',OLD.id);
 RETURN NULL;
END $$;
CREATE TRIGGER protocol_key_changed AFTER UPDATE OF revoked_at,permissions,domains ON api_keys FOR EACH ROW
 WHEN (OLD.revoked_at IS DISTINCT FROM NEW.revoked_at OR OLD.permissions IS DISTINCT FROM NEW.permissions OR OLD.domains IS DISTINCT FROM NEW.domains)
 EXECUTE FUNCTION protocol_key_changed();
CREATE TRIGGER protocol_key_removed AFTER DELETE ON api_keys FOR EACH ROW EXECUTE FUNCTION protocol_key_changed();
CREATE TRIGGER protocol_key_changed AFTER UPDATE OF revoked_at,permissions,mailbox_ids,expires_at ON mailbox_keys FOR EACH ROW
 WHEN (OLD.revoked_at IS DISTINCT FROM NEW.revoked_at OR OLD.permissions IS DISTINCT FROM NEW.permissions OR OLD.mailbox_ids IS DISTINCT FROM NEW.mailbox_ids OR OLD.expires_at IS DISTINCT FROM NEW.expires_at)
 EXECUTE FUNCTION protocol_key_changed();
CREATE TRIGGER protocol_key_removed AFTER DELETE ON mailbox_keys FOR EACH ROW EXECUTE FUNCTION protocol_key_changed();
