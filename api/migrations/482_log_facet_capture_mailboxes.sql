-- Never enumerate a mailbox's messages on its writer. A changed lifetime is expanded by
-- indexed, resumable pages on the low-priority consumer. Clock-only expiry is a read-model deadline.
SET LOCAL lock_timeout = '2s';

CREATE FUNCTION log_facet_capture_mailboxes() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO log_facet_changes(source,workspace_id,entity_id)
    SELECT 'box',workspace_id,id FROM facet_new;
  ELSIF TG_OP = 'DELETE' THEN
    INSERT INTO log_facet_changes(source,workspace_id,entity_id)
    SELECT 'box',workspace_id,id FROM facet_old;
  ELSE
    WITH changed AS MATERIALIZED (
      SELECT o.workspace_id AS old_ws,o.id AS old_id,n.workspace_id AS new_ws,n.id AS new_id
      FROM facet_old o FULL JOIN facet_new n ON n.id=o.id
      WHERE (o.workspace_id,o.delete_after) IS DISTINCT FROM (n.workspace_id,n.delete_after)
    )
    INSERT INTO log_facet_changes(source,workspace_id,entity_id)
    SELECT 'box',ws,id FROM (
      SELECT old_ws AS ws,old_id AS id FROM changed WHERE old_id IS NOT NULL
      UNION SELECT new_ws,new_id FROM changed WHERE new_id IS NOT NULL
    ) x;
  END IF;
  RETURN NULL;
END $$;

CREATE TRIGGER zz_log_facet_boxes_insert AFTER INSERT ON mailboxes
  REFERENCING NEW TABLE AS facet_new FOR EACH STATEMENT EXECUTE FUNCTION log_facet_capture_mailboxes();
CREATE TRIGGER zz_log_facet_boxes_update AFTER UPDATE ON mailboxes
  REFERENCING OLD TABLE AS facet_old NEW TABLE AS facet_new FOR EACH STATEMENT EXECUTE FUNCTION log_facet_capture_mailboxes();
CREATE TRIGGER zz_log_facet_boxes_delete AFTER DELETE ON mailboxes
  REFERENCING OLD TABLE AS facet_old FOR EACH STATEMENT EXECUTE FUNCTION log_facet_capture_mailboxes();
