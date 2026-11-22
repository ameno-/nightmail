SET LOCAL lock_timeout='2s';
-- Account notices (src/account-notices.ts): the emails about a workspace's account that no standing event or billing
-- notice already records: a domain that stopped verifying, the daily limit reached, the evaluation finished, a teammate
-- invitation and a waitlisted address let in. As billing_notices (migration 291): one row per dedupe key, so one moment
-- is one email however often its trigger fires, with the job that sends it (account.notify) queued by the statement
-- that inserts the row. The row is also what lets the dispatcher release the email (its origin is notice:<id>).
CREATE TABLE account_notices (
  id text PRIMARY KEY,
  workspace_id text NOT NULL,
  kind text NOT NULL,
  dedupe_key text NOT NULL UNIQUE,
  data jsonb NOT NULL DEFAULT '{}',
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sending','sent','suppressed','failed')),
  lease_until timestamptz, sent_at timestamptz, created_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX account_notices_workspace ON account_notices (workspace_id, kind, created_at DESC);
