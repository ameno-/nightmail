SET LOCAL lock_timeout='2s';
-- The customers list (hosted; src/signups.ts): every account that owns a workspace, at its verified address, is a contact
-- of one list in the platform workspace (NIGHTMAIL_PLATFORM_DOMAIN_WORKSPACE), for product news and service status.
-- Nothing is set by hand: the first signups.sync run that has someone to write makes the list and records it here, under
-- an advisory lock, so it is made once and found by its ID whatever it is renamed to. A list deleted since stays deleted:
-- the row keeps its ID and nothing is written. To make it again, a migration deletes the row; the next run makes a new
-- list and writes every account to it.
CREATE TABLE nightmail_customers_list (
  workspace_id text PRIMARY KEY,
  list_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- What was written for each account: the workspace, list and address. An account is due while it qualifies and its row
-- names another list or address; a row whose account no longer qualifies (deleted, owning no workspace, its address no
-- longer verified) is due to come off, and goes once its membership is removed. No foreign key, so a deleted account's
-- row outlives it until then. Two new tables: no existing table is locked or rewritten.
CREATE TABLE nightmail_customers (
  user_id text PRIMARY KEY,
  workspace_id text NOT NULL,
  list_id text NOT NULL,
  email text NOT NULL CHECK (email = lower(email) AND length(email) <= 320),
  written_at timestamptz NOT NULL DEFAULT now()
);
