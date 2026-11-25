SET LOCAL lock_timeout='2s';
-- Template assets are uploaded files too (src/templates.ts saveAsset): they count against the workspace's stored-file
-- cap like attachments and their reservations (093). The trigger's lock on template_assets holds new uploads until this
-- commits, so the reconciliation below counts every existing asset once.
CREATE TRIGGER template_asset_usage AFTER INSERT OR DELETE OR UPDATE OF workspace_id,size ON template_assets FOR EACH ROW EXECUTE FUNCTION sending_asset_delta();
CREATE OR REPLACE FUNCTION reconcile_asset_usage() RETURNS void LANGUAGE sql AS $$
INSERT INTO sending_asset_usage SELECT workspace_id,sum(delta) FROM (
  SELECT workspace_id,size AS delta FROM sending_attachments UNION ALL SELECT workspace_id,size FROM sending_upload_reservations
  UNION ALL SELECT workspace_id,size FROM template_assets
  UNION ALL SELECT workspace_id,-bytes FROM sending_asset_usage
) a GROUP BY 1 HAVING sum(delta)<>0 ORDER BY 1 ON CONFLICT(workspace_id) DO UPDATE SET bytes=sending_asset_usage.bytes+excluded.bytes;
$$;
SELECT reconcile_asset_usage();
