SET LOCAL lock_timeout='2s';
-- Contract step for migration 322 (one endpoints table). 322 kept mail_endpoints and mail_action_policies, with triggers
-- copying writes both ways, for the Worker deployed before it, which read and wrote those tables while the two Workers
-- overlapped. That Worker is gone: every reader and writer uses the endpoint's own mailbox_webhooks row, and the only
-- writer left on the two tables is the mail_endpoint_to_legacy trigger. This drops both tables, the three triggers and
-- their functions, once every legacy row is proven to be on its endpoint row.
--
-- One transaction: if the check below refuses, nothing has changed. Locks are taken in every endpoint writer's order
-- (#357): mailbox_webhooks first, which also stops the trigger that writes the copies, then the two tables.
LOCK TABLE mailbox_webhooks, mail_endpoints, mail_action_policies IN ACCESS EXCLUSIVE MODE;

-- The proof. Each legacy row must have its endpoint row in the same workspace (the legacy foreign keys are on hook_id
-- alone, so a row in another workspace was never copied: 322 and its triggers match on both), and every field 322 moved
-- must be equal there, null-safely. The endpoint row is what every Worker reads, so a difference is never settled by
-- copying the legacy value over it: the migration stops and names the query that lists each row and what differs.
--   endpoint: type and name (ref), encrypted target, verified, proof hash, expiry, request time and sender, confirmed,
--             declined, preverified by.
--   policy:   per_minute, retry_on_timeout, idempotent.
-- Not compared, because the endpoint row never carried it: mail_endpoints.created_at. The Worker that wrote these rows
-- inserted the endpoint row and its legacy row in one transaction, both defaulting to now(), and nothing updated it
-- later, so it equals the endpoint row's created_at, which the API has shown since 322. Only a hand edit makes them
-- differ; such a legacy value is dropped with the table and the endpoint row keeps its own.
DO $$ DECLARE
  endpoints constant text := $q$SELECT d.workspace_id, d.hook_id, CASE WHEN h.id IS NULL THEN 'unmatched' ELSE concat_ws(',',
      CASE WHEN h.type IS DISTINCT FROM split_part(d.ref, ':', 1) THEN 'type' END, CASE WHEN h.key IS DISTINCT FROM split_part(d.ref, ':', 2) THEN 'key' END,
      CASE WHEN h.encrypted_target IS DISTINCT FROM d.encrypted_value THEN 'encrypted_target' END, CASE WHEN h.verified IS DISTINCT FROM d.verified THEN 'verified' END,
      CASE WHEN h.proof_hash IS DISTINCT FROM d.proof_hash THEN 'proof_hash' END, CASE WHEN h.expires_at IS DISTINCT FROM d.expires_at THEN 'expires_at' END,
      CASE WHEN h.requested_at IS DISTINCT FROM d.requested_at THEN 'requested_at' END, CASE WHEN h.request_from IS DISTINCT FROM d.request_from THEN 'request_from' END,
      CASE WHEN h.confirmed_at IS DISTINCT FROM d.confirmed_at THEN 'confirmed_at' END, CASE WHEN h.declined_at IS DISTINCT FROM d.declined_at THEN 'declined_at' END,
      CASE WHEN h.preverified_by IS DISTINCT FROM d.preverified_by THEN 'preverified_by' END) END AS differs
    FROM mail_endpoints d LEFT JOIN mailbox_webhooks h ON h.workspace_id = d.workspace_id AND h.id = d.hook_id$q$;
  policies constant text := $q$SELECT p.workspace_id, p.hook_id, CASE WHEN h.id IS NULL THEN 'unmatched' ELSE concat_ws(',',
      CASE WHEN h.per_minute IS DISTINCT FROM p.per_minute THEN 'per_minute' END, CASE WHEN h.retry_on_timeout IS DISTINCT FROM p.retry_on_timeout THEN 'retry_on_timeout' END,
      CASE WHEN h.idempotent IS DISTINCT FROM p.idempotent THEN 'idempotent' END) END AS differs
    FROM mail_action_policies p LEFT JOIN mailbox_webhooks h ON h.workspace_id = p.workspace_id AND h.id = p.hook_id$q$;
  bad_endpoints bigint; bad_policies bigint;
BEGIN
  EXECUTE format('SELECT count(*) FROM (%s) x WHERE differs <> %L', endpoints, '') INTO bad_endpoints;
  EXECUTE format('SELECT count(*) FROM (%s) x WHERE differs <> %L', policies, '') INTO bad_policies;
  IF bad_endpoints + bad_policies > 0 THEN
    RAISE EXCEPTION 'ENDPOINT_MIRROR_DIFFERS: % legacy endpoint row(s) and % legacy policy row(s) are not exactly on their mailbox_webhooks row. No data was changed. List them with: SELECT * FROM (%) x WHERE differs <> ''''; and: SELECT * FROM (%) x WHERE differs <> ''''; For each row, decide which value is right. If it is the legacy one, correct the mailbox_webhooks row (what every Worker reads); otherwise delete the stale legacy row. Never copy a legacy value over without checking it. Then migrate again.',
      bad_endpoints, bad_policies, endpoints, policies;
  END IF;
END $$;

DROP TRIGGER mail_endpoint_to_legacy ON mailbox_webhooks;
DROP TABLE mail_action_policies, mail_endpoints; -- and their triggers mail_policy_from_legacy and mail_endpoint_from_legacy
DROP FUNCTION mail_endpoint_to_legacy(), mail_endpoint_from_legacy(), mail_policy_from_legacy();
