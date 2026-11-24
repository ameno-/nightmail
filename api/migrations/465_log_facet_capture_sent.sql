-- One hot relation per installation transaction. AFTER statement transitions include the
-- actual status chosen by the existing rank, billing and tally triggers; no new writer locks
-- on those tables or shared counters. Equal old and new cells produce no journal row.
SET LOCAL lock_timeout = '2s';

CREATE FUNCTION log_facet_capture_sent() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO log_facet_changes(source,workspace_id,region,minute,kind,status,delta)
    SELECT 'sent',workspace_id,region,date_trunc('minute',created_at,'UTC'),snapshot->>'kind',status,count(*)
    FROM facet_new WHERE snapshot->>'kind' IN ('transactional','marketing') GROUP BY 2,3,4,5,6;
  ELSIF TG_OP = 'DELETE' THEN
    INSERT INTO log_facet_changes(source,workspace_id,region,minute,kind,status,delta)
    SELECT 'sent',workspace_id,region,date_trunc('minute',created_at,'UTC'),snapshot->>'kind',status,-count(*)
    FROM facet_old WHERE snapshot->>'kind' IN ('transactional','marketing') GROUP BY 2,3,4,5,6;
  ELSE
    INSERT INTO log_facet_changes(source,workspace_id,region,minute,kind,status,delta)
    SELECT 'sent',workspace_id,region,minute,kind,status,sum(d)::bigint FROM (
      SELECT workspace_id,region,date_trunc('minute',created_at,'UTC') AS minute,snapshot->>'kind' AS kind,status,1 AS d
      FROM facet_new
      UNION ALL
      SELECT workspace_id,region,date_trunc('minute',created_at,'UTC'),snapshot->>'kind',status,-1 FROM facet_old
    ) x WHERE kind IN ('transactional','marketing')
    GROUP BY 2,3,4,5,6 HAVING sum(d)<>0;
  END IF;
  RETURN NULL;
END $$;

CREATE TRIGGER zz_log_facet_sent_insert AFTER INSERT ON sending_emails
  REFERENCING NEW TABLE AS facet_new FOR EACH STATEMENT EXECUTE FUNCTION log_facet_capture_sent();
CREATE TRIGGER zz_log_facet_sent_update AFTER UPDATE ON sending_emails
  REFERENCING OLD TABLE AS facet_old NEW TABLE AS facet_new FOR EACH STATEMENT EXECUTE FUNCTION log_facet_capture_sent();
CREATE TRIGGER zz_log_facet_sent_delete AFTER DELETE ON sending_emails
  REFERENCING OLD TABLE AS facet_old FOR EACH STATEMENT EXECUTE FUNCTION log_facet_capture_sent();
