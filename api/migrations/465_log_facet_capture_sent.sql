-- One hot relation per installation transaction. Preserve the exact old/new sort keys in small
-- packets: a resumable backfill can split a very hot minute at (created_at,id), without rereading
-- the entire minute or counting a late commit twice. The receiver can sum delta without unpacking
-- IDs once that coverage is certified. No source lookup, advisory lock or shared-counter update.
SET LOCAL lock_timeout = '2s';

CREATE FUNCTION log_facet_capture_sent() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO log_facet_changes(source,workspace_id,region,minute,source_at,kind,status,delta,sent_ids)
    SELECT 'sent',workspace_id,region,date_trunc('minute',created_at,'UTC'),created_at,kind,status,d*count(*),array_agg(id ORDER BY id)
    FROM (
      SELECT x.*, (row_number() OVER (PARTITION BY workspace_id,region,created_at,kind,status,d ORDER BY id)-1)/128 AS packet
      FROM (SELECT id,workspace_id,region,created_at,snapshot->>'kind' AS kind,status,1 AS d FROM facet_new) x WHERE kind IN ('transactional','marketing')
    ) numbered GROUP BY workspace_id,region,created_at,kind,status,d,packet;
  ELSIF TG_OP = 'DELETE' THEN
    INSERT INTO log_facet_changes(source,workspace_id,region,minute,source_at,kind,status,delta,sent_ids)
    SELECT 'sent',workspace_id,region,date_trunc('minute',created_at,'UTC'),created_at,kind,status,d*count(*),array_agg(id ORDER BY id)
    FROM (
      SELECT x.*, (row_number() OVER (PARTITION BY workspace_id,region,created_at,kind,status,d ORDER BY id)-1)/128 AS packet
      FROM (SELECT id,workspace_id,region,created_at,snapshot->>'kind' AS kind,status,-1 AS d FROM facet_old) x WHERE kind IN ('transactional','marketing')
    ) numbered GROUP BY workspace_id,region,created_at,kind,status,d,packet;
  ELSE
    WITH moved AS MATERIALIZED (
      SELECT o.id AS old_id,o.workspace_id AS old_ws,o.region AS old_region,o.created_at AS old_at,
             o.snapshot->>'kind' AS old_kind,o.status AS old_status,
             n.id AS new_id,n.workspace_id AS new_ws,n.region AS new_region,n.created_at AS new_at,
             n.snapshot->>'kind' AS new_kind,n.status AS new_status
      FROM facet_old o FULL JOIN facet_new n ON n.id=o.id
      WHERE (o.workspace_id,o.region,o.created_at,o.snapshot->>'kind',o.status) IS DISTINCT FROM
            (n.workspace_id,n.region,n.created_at,n.snapshot->>'kind',n.status)
    )
    INSERT INTO log_facet_changes(source,workspace_id,region,minute,source_at,kind,status,delta,sent_ids)
    SELECT 'sent',workspace_id,region,date_trunc('minute',created_at,'UTC'),created_at,kind,status,d*count(*),array_agg(id ORDER BY id)
    FROM (
      SELECT x.*, (row_number() OVER (PARTITION BY workspace_id,region,created_at,kind,status,d ORDER BY id)-1)/128 AS packet
      FROM (SELECT old_id AS id,old_ws AS workspace_id,old_region AS region,old_at AS created_at,old_kind AS kind,old_status AS status,-1 AS d
            FROM moved WHERE old_id IS NOT NULL
            UNION ALL SELECT new_id,new_ws,new_region,new_at,new_kind,new_status,1 FROM moved WHERE new_id IS NOT NULL) x WHERE kind IN ('transactional','marketing')
    ) numbered GROUP BY workspace_id,region,created_at,kind,status,d,packet;
  END IF;
  RETURN NULL;
END $$;

CREATE TRIGGER zz_log_facet_sent_insert AFTER INSERT ON sending_emails
  REFERENCING NEW TABLE AS facet_new FOR EACH STATEMENT EXECUTE FUNCTION log_facet_capture_sent();
CREATE TRIGGER zz_log_facet_sent_update AFTER UPDATE ON sending_emails
  REFERENCING OLD TABLE AS facet_old NEW TABLE AS facet_new FOR EACH STATEMENT EXECUTE FUNCTION log_facet_capture_sent();
CREATE TRIGGER zz_log_facet_sent_delete AFTER DELETE ON sending_emails
  REFERENCING OLD TABLE AS facet_old FOR EACH STATEMENT EXECUTE FUNCTION log_facet_capture_sent();
