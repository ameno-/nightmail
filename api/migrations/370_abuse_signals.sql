SET LOCAL lock_timeout='2s';
-- Abuse and fraud monitoring (hosted only, src/abuse.ts). Monitoring only: nothing reads these tables on the send path,
-- and nothing here blocks, pauses or limits anyone.
--
-- abuse_signals: one small fact about an entity (a user, a workspace, or a refused sign-in that has no user yet), seen
-- one or more times. A value is a keyed one-way hash (an address, a network, a browser, a card, a recipient, a content
-- fingerprint) or a value that names no person (a domain, an ASN, a country, a flag). Never a raw address, IP, user
-- agent, card detail or message text. Rows leave by age of last_at (src/abuse.ts abuseExpired).
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

-- identity_links: two entities that hold the same signal value, by kind, with how many values they share. Derived from
-- abuse_signals by the hourly job and replaced by it: a link whose signals are gone is deleted at the next run.
CREATE TABLE identity_links (
  a_type text NOT NULL, a_id text NOT NULL,
  b_type text NOT NULL, b_id text NOT NULL,
  kind text NOT NULL,
  shared integer NOT NULL CHECK (shared > 0),
  first_at timestamptz NOT NULL,
  last_at timestamptz NOT NULL,
  PRIMARY KEY (a_type, a_id, b_type, b_id, kind),
  CHECK ((a_type, a_id) < (b_type, b_id))
);
CREATE INDEX identity_links_b ON identity_links(b_type, b_id);

-- abuse_sampling: how far the hourly sampler has read each workspace's sent mail.
CREATE TABLE abuse_sampling (
  workspace_id text PRIMARY KEY,
  sampled_through timestamptz NOT NULL,
  sampled_at timestamptz NOT NULL DEFAULT now()
);
