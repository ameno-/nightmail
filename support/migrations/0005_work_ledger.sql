-- The work ledger (support/README.md "Work and the sweep"): every message either flow accepted or kept, and a mirror of
-- each Durable Object's work items, so the cron finds what is waiting without asking every object.

CREATE TABLE support_work (
  flow TEXT NOT NULL CHECK (flow IN ('support', 'intake')),
  object TEXT NOT NULL,     -- the Durable Object's ID (hex); '' for mail kept at the edge before reaching one
  id TEXT NOT NULL,         -- the item: msg:<messageId>, answer:<messageId>, notify:<ticketId>, …
  kind TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending', 'blocked', 'parked', 'done', 'held', 'dead')),
  reason TEXT,              -- edge rows: rate (the per-sender limiter) or unconfigured (an intake address not configured)
  source TEXT,              -- message rows: webhook or poller, whichever accepted the message first
  message_id TEXT,
  thread_id TEXT,
  detail TEXT,              -- edge rows: what accepting the message later needs (JSON: the recipients)
  attempts INTEGER NOT NULL DEFAULT 0,
  due_at INTEGER,
  last_error TEXT,          -- class:status:code and a request ID; never message text
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (flow, object, id)
);
CREATE INDEX support_work_message ON support_work (flow, message_id);
CREATE INDEX support_work_item ON support_work (id);
CREATE INDEX support_work_state ON support_work (state, updated_at);

-- The replay poller's position per flow and receiving address; address_id '*' holds the flow's starting cursor.
CREATE TABLE replay_cursors (
  flow TEXT NOT NULL,
  address_id TEXT NOT NULL,
  cursor TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (flow, address_id)
);

-- Each flow's key self-check: whether its key reads exactly the configured addresses.
CREATE TABLE support_checks (
  flow TEXT PRIMARY KEY,
  keys TEXT NOT NULL,       -- ok, missing, extra, unauthorized or unavailable
  missing INTEGER NOT NULL DEFAULT 0,
  extra INTEGER NOT NULL DEFAULT 0,
  checked_at INTEGER NOT NULL
);

-- Team emails the cron sends once (the over-cap digest, cap alerts): the request is frozen when first queued and resent
-- under the same idempotency key until Nightmail accepts it.
CREATE TABLE support_notices (
  key TEXT PRIMARY KEY,     -- the idempotency key: overflow-<day>, cap-<kind>-<day>
  request TEXT NOT NULL,    -- JSON: addressId, to, subject, text
  attempts INTEGER NOT NULL DEFAULT 0,
  due_at INTEGER NOT NULL,
  sent_at INTEGER,
  last_error TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX support_notices_unsent ON support_notices (sent_at, due_at);
