-- link.workspace_id is a hint, not the message's owner. Both the current and materialized
-- owner must be resolved by message ID before a distinct retained-message value is certified.
SET LOCAL lock_timeout = '2s';

CREATE FUNCTION log_facet_capture_links() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO log_facet_changes(source,workspace_id,entity_id)
    SELECT DISTINCT 'link',workspace_id,message_id FROM facet_new;
  ELSIF TG_OP = 'DELETE' THEN
    INSERT INTO log_facet_changes(source,workspace_id,entity_id)
    SELECT DISTINCT 'link',workspace_id,message_id FROM facet_old;
  ELSE
    WITH changed AS MATERIALIZED (
      SELECT o.workspace_id AS old_ws,o.message_id AS old_id,n.workspace_id AS new_ws,n.message_id AS new_id
      FROM facet_old o FULL JOIN facet_new n ON (o.mailbox_id,o.message_id)=(n.mailbox_id,n.message_id)
      WHERE (o.workspace_id,o.held_reason IS NULL) IS DISTINCT FROM (n.workspace_id,n.held_reason IS NULL)
    )
    INSERT INTO log_facet_changes(source,workspace_id,entity_id)
    SELECT 'link',ws,id FROM (
      SELECT old_ws AS ws,old_id AS id FROM changed WHERE old_id IS NOT NULL
      UNION SELECT new_ws,new_id FROM changed WHERE new_id IS NOT NULL
    ) x;
  END IF;
  RETURN NULL;
END $$;

CREATE TRIGGER zz_log_facet_links_insert AFTER INSERT ON mailbox_messages
  REFERENCING NEW TABLE AS facet_new FOR EACH STATEMENT EXECUTE FUNCTION log_facet_capture_links();
CREATE TRIGGER zz_log_facet_links_update AFTER UPDATE ON mailbox_messages
  REFERENCING OLD TABLE AS facet_old NEW TABLE AS facet_new FOR EACH STATEMENT EXECUTE FUNCTION log_facet_capture_links();
CREATE TRIGGER zz_log_facet_links_delete AFTER DELETE ON mailbox_messages
  REFERENCING OLD TABLE AS facet_old FOR EACH STATEMENT EXECUTE FUNCTION log_facet_capture_links();
