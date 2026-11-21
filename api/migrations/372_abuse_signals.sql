SET LOCAL lock_timeout='2s';
-- Abuse and fraud monitoring (hosted only, src/abuse.ts). Monitoring only: nothing reads these tables on the send path,
-- and nothing here blocks, pauses or limits anyone. Nothing is written until NIGHTMAIL_ABUSE_MONITORING names an
-- activation time that has passed.
--
-- abuse_signals: one small fact about an entity (a user, a workspace, or a refused sign-in that has no user yet), seen
-- one or more times. A value is a keyed one-way hash (an address, a network, a card, a domain, a content
-- fingerprint) or a value that names no person (an ASN, a browser family, a flag). Never a raw address, IP, user
-- agent, card detail, domain, recipient or message text. Rows leave by age of last_at (src/abuse.ts abuseExpired),
-- and each entity keeps a bounded number of values per kind.
CREATE TABLE abuse_signals (
  entity_type text NOT NULL CHECK (entity_type IN ('user','workspace','attempt')),
  entity_id text NOT NULL CHECK (length(entity_id) BETWEEN 1 AND 200),
  kind text NOT NULL CHECK (kind ~ '^[a-z_]{1,32}$'),
  value text NOT NULL CHECK (length(value) BETWEEN 1 AND 255),
  seen integer NOT NULL DEFAULT 1 CHECK (seen > 0),
  detail jsonb CHECK (detail IS NULL OR octet_length(detail::text) <= 1000),
  first_at timestamptz NOT NULL DEFAULT now(),
  last_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (entity_type, entity_id, kind, value)
);
CREATE INDEX abuse_signals_value ON abuse_signals(kind, value);
CREATE INDEX abuse_signals_last ON abuse_signals(last_at);

-- abuse_exclusions: entities monitoring never records (an upheld objection, or an agreement that rules it out). Set by
-- an operator (scripts/abuse-subject.ts); kept until removed.
CREATE TABLE abuse_exclusions (
  entity_type text NOT NULL CHECK (entity_type IN ('user','workspace','attempt')),
  entity_id text NOT NULL CHECK (length(entity_id) BETWEEN 1 AND 200),
  reason text NOT NULL CHECK (length(reason) BETWEEN 10 AND 500),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (entity_type, entity_id)
);

-- abuse_sampling: how far the hourly sampler has read each workspace's accepted Hosted mail.
CREATE TABLE abuse_sampling (
  workspace_id text PRIMARY KEY,
  sampled_through timestamptz NOT NULL,
  sampled_at timestamptz NOT NULL DEFAULT now()
);

-- abuse_state: the hourly job's one row. Its lease keeps two runs from overlapping; active_since is the instant this
-- database first ran with the configured activation time, and nothing created before it is ever read; cursors let each
-- stage continue where the last run stopped.
CREATE TABLE abuse_state (
  id text PRIMARY KEY CHECK (id = 'monitor'),
  configured timestamptz NOT NULL,
  active_since timestamptz NOT NULL,
  lease_until timestamptz,
  cursors jsonb NOT NULL DEFAULT '{}' CHECK (octet_length(cursors::text) <= 2000)
);
