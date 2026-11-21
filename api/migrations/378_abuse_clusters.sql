SET LOCAL lock_timeout='2s';
-- Abuse monitoring, part 2 (src/abuse.ts, src/abuse-clusters.ts): which entities share signals, and the groups they form.
-- Derived data only, read by operators; nothing on the send path reads it and nothing here blocks anyone.
--
-- identity_links: two entities that hold the same signal value, by kind, with how many values they share. Written by
-- the hourly job for the values it has just written (never rebuilt as a whole), checked against the signals again
-- whenever it is read, and deleted with the signals it came from (src/abuse.ts linkExpired, and an erasure).
-- pending: the pair has not been grouped since it last changed.
CREATE TABLE identity_links (
  a_type text NOT NULL, a_id text NOT NULL,
  b_type text NOT NULL, b_id text NOT NULL,
  kind text NOT NULL CHECK (kind ~ '^[a-z_]{1,32}$'),
  shared integer NOT NULL CHECK (shared > 0),
  first_at timestamptz NOT NULL,
  last_at timestamptz NOT NULL,
  pending boolean NOT NULL DEFAULT true,
  PRIMARY KEY (a_type, a_id, b_type, b_id, kind),
  CHECK ((a_type, a_id) < (b_type, b_id))
);
CREATE INDEX identity_links_b ON identity_links(b_type, b_id);
CREATE INDEX identity_links_last ON identity_links(last_at);
CREATE INDEX identity_links_pending ON identity_links(last_at) WHERE pending;

-- abuse_clusters: accounts and workspaces joined by ownership and by links strong enough together, with a risk score
-- and the reasons behind each point. Rescored in rotation by the hourly job; one that is no longer rescored (monitoring
-- off, or its links gone) is deleted after 30 days. members and edges name entities by ID, never by a signal's value.
CREATE TABLE abuse_clusters (
  id text PRIMARY KEY CHECK (id ~ '^acl_[0-9a-f]{24}$'),
  score smallint NOT NULL CHECK (score BETWEEN 0 AND 100),
  band text NOT NULL CHECK (band IN ('low','watch','review','high')),
  peak smallint NOT NULL CHECK (peak BETWEEN 0 AND 100),
  accounts integer NOT NULL CHECK (accounts >= 2),
  workspaces integer NOT NULL CHECK (workspaces >= 0),
  reasons jsonb NOT NULL CHECK (octet_length(reasons::text) <= 4000),
  members jsonb NOT NULL CHECK (octet_length(members::text) <= 20000),
  edges jsonb NOT NULL CHECK (octet_length(edges::text) <= 100000),
  first_at timestamptz NOT NULL DEFAULT now(),
  changed_at timestamptz NOT NULL DEFAULT now(),
  scored_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX abuse_clusters_rank ON abuse_clusters(score DESC, id DESC);
CREATE INDEX abuse_clusters_scored ON abuse_clusters(scored_at);

-- An entity belongs to at most one cluster.
CREATE TABLE abuse_cluster_members (
  entity_type text NOT NULL CHECK (entity_type IN ('user','workspace','attempt')),
  entity_id text NOT NULL,
  cluster_id text NOT NULL REFERENCES abuse_clusters(id) ON DELETE CASCADE,
  PRIMARY KEY (entity_type, entity_id)
);
CREATE INDEX abuse_cluster_members_cluster ON abuse_cluster_members(cluster_id);
