SET LOCAL lock_timeout='2s';
-- Contract step for migration 322 (one endpoints table). 322 kept mail_endpoints and mail_action_policies, with triggers
-- copying writes both ways, for the Worker deployed before it, which read and wrote those tables while the two Workers
-- overlapped. That Worker is gone: every reader and writer uses the endpoint's own mailbox_webhooks row, and the only
-- writer left on the two tables is the mail_endpoint_to_legacy trigger. Their rows are copies of columns on that row
-- (322's backfill, then the triggers), so dropping them loses nothing the row doesn't hold. This drops both tables, the
-- three triggers and their functions.
--
-- One transaction: if the check below refuses, nothing has changed. Locks are taken in every endpoint writer's order
-- (#357): mailbox_webhooks first, which also stops the trigger that writes the copies, then the two tables.
LOCK TABLE mailbox_webhooks, mail_endpoints, mail_action_policies IN ACCESS EXCLUSIVE MODE;

-- A Slack, Discord or forward endpoint whose copy never reached its row would still read as a webhook (the type only
-- switches between Slack and Discord), and a policy whose copy never reached it would read as no policy. Its row is
-- what every Worker reads, so stop rather than drop the only place that holds the endpoint's target or policy.
DO $$ BEGIN
  IF EXISTS (SELECT FROM mail_endpoints d JOIN mailbox_webhooks h ON h.id=d.hook_id WHERE h.type='webhook') THEN
    RAISE EXCEPTION 'ENDPOINT_COPY_MISSING: a Slack, Discord or forward endpoint in mail_endpoints was never copied onto its mailbox_webhooks row. No data was changed. List them with: SELECT d.workspace_id, d.hook_id, d.ref FROM mail_endpoints d JOIN mailbox_webhooks h ON h.id = d.hook_id WHERE h.type = ''webhook''; then run the first backfill UPDATE in migration 322_one_endpoints_table.sql and migrate again.';
  END IF;
  IF EXISTS (SELECT FROM mail_action_policies p JOIN mailbox_webhooks h ON h.id=p.hook_id WHERE h.per_minute IS NULL) THEN
    RAISE EXCEPTION 'ENDPOINT_POLICY_COPY_MISSING: an endpoint policy in mail_action_policies was never copied onto its mailbox_webhooks row. No data was changed. List them with: SELECT p.workspace_id, p.hook_id, p.per_minute FROM mail_action_policies p JOIN mailbox_webhooks h ON h.id = p.hook_id WHERE h.per_minute IS NULL; then run the second backfill UPDATE in migration 322_one_endpoints_table.sql and migrate again.';
  END IF;
END $$;

DROP TRIGGER mail_endpoint_to_legacy ON mailbox_webhooks;
DROP TABLE mail_action_policies, mail_endpoints; -- and their triggers mail_policy_from_legacy and mail_endpoint_from_legacy
DROP FUNCTION mail_endpoint_to_legacy(), mail_endpoint_from_legacy(), mail_policy_from_legacy();
