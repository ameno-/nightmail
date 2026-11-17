SET LOCAL lock_timeout='2s';
-- One endpoints table. Every endpoint already has a mailbox_webhooks row, and deliveries, routes, grants, attempt
-- fences and forward-once rows reference its ID. A Slack, Discord or forward endpoint's row was a placeholder
-- (https://ritual.invalid/ and a throwaway secret) whose target, confirmation and policy lived in mail_endpoints and
-- mail_action_policies. They move onto the row: its type, its encrypted target, the forward confirmation columns and
-- the policy. Every ID stays (con_ for Slack, Discord and forward endpoints, mwh_ for webhooks), and a non-webhook
-- endpoint's name moves to key, which webhooks already use, so one unique index covers every endpoint name.
--
-- Expand only. The migration runs before the new Worker replaces the old one, and the old Worker keeps reading and
-- writing mail_endpoints and mail_action_policies until it is gone:
--   * mail_endpoint_from_legacy and mail_policy_from_legacy copy each of its writes onto the row, so the new code
--     reads only mailbox_webhooks, also for rows the old Worker creates or changes during the deploy;
--   * mail_endpoint_to_legacy copies the new code's writes back to the old tables, so the old Worker still delivers,
--     confirms and stops what the new one created or changed while it drains.
-- Each copy runs only for a write made by a caller (pg_trigger_depth), so the two directions never loop.
-- A later release drops mail_endpoints, mail_action_policies and these triggers.
--
-- Locks are taken in the writers' order: mailbox_webhooks first, then mail_endpoints and mail_action_policies.
-- Idempotent: IF NOT EXISTS, CREATE OR REPLACE and DROP ... IF EXISTS throughout; the backfill sets the same values again.

ALTER TABLE mailbox_webhooks
  ADD COLUMN IF NOT EXISTS type text NOT NULL DEFAULT 'webhook',
  ADD COLUMN IF NOT EXISTS encrypted_target text,
  ADD COLUMN IF NOT EXISTS verified boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS proof_hash text,
  ADD COLUMN IF NOT EXISTS expires_at timestamptz,
  ADD COLUMN IF NOT EXISTS requested_at timestamptz,
  ADD COLUMN IF NOT EXISTS request_from text,
  ADD COLUMN IF NOT EXISTS confirmed_at timestamptz,
  ADD COLUMN IF NOT EXISTS declined_at timestamptz,
  ADD COLUMN IF NOT EXISTS preverified_by text,
  ADD COLUMN IF NOT EXISTS per_minute integer,
  ADD COLUMN IF NOT EXISTS retry_on_timeout boolean,
  ADD COLUMN IF NOT EXISTS idempotent boolean,
  -- Only a webhook has a URL and a signing secret.
  ALTER COLUMN url DROP NOT NULL,
  ALTER COLUMN encrypted_secret DROP NOT NULL;

-- An endpoint name is one name space across every type: refuse, changing nothing, if a Slack, Discord or forward
-- endpoint and a keyed webhook already share one (the API has refused that since endpoints were named).
DO $$ BEGIN
  IF EXISTS (SELECT FROM mail_endpoints d JOIN mailbox_webhooks h ON h.workspace_id=d.workspace_id AND h.key=split_part(d.ref,':',2) AND h.id<>d.hook_id) THEN
    RAISE EXCEPTION 'ENDPOINT_NAME_CONFLICT: a Slack, Discord or forward endpoint has the same name as a keyed webhook in one workspace. Rename one, then migrate again. No data was changed.';
  END IF;
END $$;

-- The old Worker's writes, onto the row.
CREATE OR REPLACE FUNCTION mail_endpoint_from_legacy() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF pg_trigger_depth() > 1 THEN RETURN NULL; END IF;
  UPDATE mailbox_webhooks SET type=split_part(NEW.ref,':',1), key=split_part(NEW.ref,':',2), name=NULL, url=NULL, encrypted_secret=NULL,
    encrypted_target=NEW.encrypted_value, verified=NEW.verified, proof_hash=NEW.proof_hash, expires_at=NEW.expires_at, requested_at=NEW.requested_at,
    request_from=NEW.request_from, confirmed_at=NEW.confirmed_at, declined_at=NEW.declined_at, preverified_by=NEW.preverified_by
  WHERE workspace_id=NEW.workspace_id AND id=NEW.hook_id;
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS mail_endpoint_from_legacy ON mail_endpoints;
CREATE TRIGGER mail_endpoint_from_legacy AFTER INSERT OR UPDATE ON mail_endpoints FOR EACH ROW EXECUTE FUNCTION mail_endpoint_from_legacy();

CREATE OR REPLACE FUNCTION mail_policy_from_legacy() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF pg_trigger_depth() > 1 THEN RETURN NULL; END IF;
  UPDATE mailbox_webhooks SET per_minute=NEW.per_minute, retry_on_timeout=NEW.retry_on_timeout, idempotent=NEW.idempotent
  WHERE workspace_id=NEW.workspace_id AND id=NEW.hook_id;
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS mail_policy_from_legacy ON mail_action_policies;
CREATE TRIGGER mail_policy_from_legacy AFTER INSERT OR UPDATE ON mail_action_policies FOR EACH ROW EXECUTE FUNCTION mail_policy_from_legacy();

-- What was already written.
UPDATE mailbox_webhooks h SET type=split_part(d.ref,':',1), key=split_part(d.ref,':',2), name=NULL, url=NULL, encrypted_secret=NULL,
  encrypted_target=d.encrypted_value, verified=d.verified, proof_hash=d.proof_hash, expires_at=d.expires_at, requested_at=d.requested_at,
  request_from=d.request_from, confirmed_at=d.confirmed_at, declined_at=d.declined_at, preverified_by=d.preverified_by
FROM mail_endpoints d WHERE d.workspace_id=h.workspace_id AND d.hook_id=h.id;
UPDATE mailbox_webhooks h SET per_minute=p.per_minute, retry_on_timeout=p.retry_on_timeout, idempotent=p.idempotent
FROM mail_action_policies p WHERE p.workspace_id=h.workspace_id AND p.hook_id=h.id;

-- The new code's writes, back to the old tables while the old Worker drains.
CREATE OR REPLACE FUNCTION mail_endpoint_to_legacy() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF pg_trigger_depth() > 1 THEN RETURN NULL; END IF;
  IF NEW.type<>'webhook' THEN
    INSERT INTO mail_endpoints(workspace_id,ref,hook_id,encrypted_value,verified,proof_hash,expires_at,requested_at,request_from,confirmed_at,declined_at,preverified_by,created_at)
    VALUES(NEW.workspace_id,NEW.type||':'||NEW.key,NEW.id,NEW.encrypted_target,NEW.verified,NEW.proof_hash,NEW.expires_at,NEW.requested_at,NEW.request_from,NEW.confirmed_at,NEW.declined_at,NEW.preverified_by,NEW.created_at)
    ON CONFLICT(hook_id) DO UPDATE SET ref=excluded.ref,encrypted_value=excluded.encrypted_value,verified=excluded.verified,proof_hash=excluded.proof_hash,expires_at=excluded.expires_at,
      requested_at=excluded.requested_at,request_from=excluded.request_from,confirmed_at=excluded.confirmed_at,declined_at=excluded.declined_at,preverified_by=excluded.preverified_by;
  END IF;
  IF NEW.per_minute IS NOT NULL THEN
    INSERT INTO mail_action_policies(workspace_id,hook_id,per_minute,retry_on_timeout,idempotent) VALUES(NEW.workspace_id,NEW.id,NEW.per_minute,NEW.retry_on_timeout,NEW.idempotent)
    ON CONFLICT(workspace_id,hook_id) DO UPDATE SET per_minute=excluded.per_minute,retry_on_timeout=excluded.retry_on_timeout,idempotent=excluded.idempotent;
  END IF;
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS mail_endpoint_to_legacy ON mailbox_webhooks;
CREATE TRIGGER mail_endpoint_to_legacy AFTER INSERT OR UPDATE OF type,key,encrypted_target,verified,proof_hash,expires_at,requested_at,request_from,confirmed_at,declined_at,preverified_by,per_minute,retry_on_timeout,idempotent
  ON mailbox_webhooks FOR EACH ROW EXECUTE FUNCTION mail_endpoint_to_legacy();

-- What each type holds. A row the old Worker inserts starts as a webhook with its placeholder URL and secret, and becomes
-- its type in the same transaction (mail_endpoint_from_legacy), so it satisfies these at every statement.
ALTER TABLE mailbox_webhooks DROP CONSTRAINT IF EXISTS mailbox_webhook_type_valid, DROP CONSTRAINT IF EXISTS mailbox_webhook_type_fields, DROP CONSTRAINT IF EXISTS mailbox_webhook_policy_valid;
ALTER TABLE mailbox_webhooks
  ADD CONSTRAINT mailbox_webhook_type_valid CHECK (type IN ('webhook','slack','discord','forward')),
  ADD CONSTRAINT mailbox_webhook_type_fields CHECK (CASE WHEN type='webhook' THEN url IS NOT NULL AND encrypted_secret IS NOT NULL
    ELSE encrypted_target IS NOT NULL AND key IS NOT NULL AND event_types='[]'::jsonb END),
  ADD CONSTRAINT mailbox_webhook_policy_valid CHECK ((per_minute IS NULL) = (retry_on_timeout IS NULL) AND (per_minute IS NULL) = (idempotent IS NULL) AND per_minute BETWEEN 1 AND 6000);
-- The confirmation page finds a pending forward by its link alone.
CREATE UNIQUE INDEX IF NOT EXISTS mailbox_webhooks_proof_hash ON mailbox_webhooks(proof_hash) WHERE proof_hash IS NOT NULL;

-- Removing an approval holds what it created: a forward shows its address, so only other types need their URL again.
CREATE OR REPLACE FUNCTION mail_disable_grant_object() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE domain text;
BEGIN
 IF OLD.kind='endpoint' THEN UPDATE mailbox_webhooks SET paused=true,reconfirm=type<>'forward' WHERE workspace_id=OLD.workspace_id AND id=OLD.resource;
 ELSIF OLD.kind='route' THEN UPDATE mail_routes SET enabled=false WHERE workspace_id=OLD.workspace_id AND id=OLD.resource RETURNING domain_id INTO domain; IF domain IS NOT NULL THEN PERFORM mail_compile_routes(OLD.workspace_id,domain); END IF;
 ELSIF OLD.kind='key' THEN UPDATE mailbox_keys SET revoked_at=now() WHERE workspace_id=OLD.workspace_id AND id=OLD.resource;
 ELSIF OLD.kind='api_key' THEN UPDATE api_keys SET revoked_at=coalesce(revoked_at,now()) WHERE workspace_id=OLD.workspace_id AND id=OLD.resource;
 END IF;
 RETURN NULL;
END $$;
