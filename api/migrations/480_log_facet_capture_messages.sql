-- A message's current contribution depends on its distinct eligible links, not the count of
-- those links. Only mark affected IDs here; the materializer reads lineage off the write path.
SET LOCAL lock_timeout = '2s';

CREATE FUNCTION log_facet_capture_messages() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO log_facet_changes(source,workspace_id,entity_id)
    SELECT 'message',workspace_id,id FROM facet_new WHERE direction='inbound';
  ELSIF TG_OP = 'DELETE' THEN
    INSERT INTO log_facet_changes(source,workspace_id,entity_id)
    SELECT 'message',workspace_id,id FROM facet_old WHERE direction='inbound';
  ELSE
    WITH changed AS MATERIALIZED (
      SELECT o.id AS old_id,o.workspace_id AS old_ws,o.direction AS old_dir,
             n.id AS new_id,n.workspace_id AS new_ws,n.direction AS new_dir
      FROM facet_old o FULL JOIN facet_new n ON n.id=o.id
      WHERE (o.workspace_id,o.direction,o.region,o.received_at,o.spam,o.lifecycle) IS DISTINCT FROM
            (n.workspace_id,n.direction,n.region,n.received_at,n.spam,n.lifecycle)
    )
    INSERT INTO log_facet_changes(source,workspace_id,entity_id)
    SELECT 'message',ws,id FROM (
      SELECT old_ws AS ws,old_id AS id FROM changed WHERE old_dir='inbound'
      UNION SELECT new_ws,new_id FROM changed WHERE new_dir='inbound'
    ) x;
  END IF;
  RETURN NULL;
END $$;

CREATE TRIGGER zz_log_facet_messages_insert AFTER INSERT ON mail_messages
  REFERENCING NEW TABLE AS facet_new FOR EACH STATEMENT EXECUTE FUNCTION log_facet_capture_messages();
CREATE TRIGGER zz_log_facet_messages_update AFTER UPDATE ON mail_messages
  REFERENCING OLD TABLE AS facet_old NEW TABLE AS facet_new FOR EACH STATEMENT EXECUTE FUNCTION log_facet_capture_messages();
CREATE TRIGGER zz_log_facet_messages_delete AFTER DELETE ON mail_messages
  REFERENCING OLD TABLE AS facet_old FOR EACH STATEMENT EXECUTE FUNCTION log_facet_capture_messages();
