-- Empty read-model objects only. Initial mail is read later by resumable, low-priority keyset
-- pages; a schema transaction never counts, locks or rewrites an existing mail table.
SET LOCAL lock_timeout = '2s';

CREATE TABLE log_facet_coverage (
  workspace_id text PRIMARY KEY,
  generation text NOT NULL,
  covered_from timestamptz NOT NULL,
  sent_after_at timestamptz,
  sent_after_id text,
  sent_done boolean NOT NULL DEFAULT false,
  sent_tail_snapshot pg_snapshot,
  sent_seed_xmax xid8,
  sent_witnesses_retired boolean NOT NULL DEFAULT false
);

-- The first upper key >= a change's precise source key is its seed snapshot. Past the final
-- populated key even deleted rows have a witness: sent_tail_snapshot on the coverage row.
CREATE TABLE log_facet_sent_seeds (
  workspace_id text NOT NULL, generation text NOT NULL,
  high_at timestamptz NOT NULL, high_id text NOT NULL, seed_snapshot pg_snapshot NOT NULL,
  PRIMARY KEY (workspace_id,generation,high_at,high_id)
);

-- Minute detail handles the one partial hour; whole hours are independent of source cardinality.
-- Empty region is the unassigned band: only the all-region dashboard can ask for it.
CREATE TABLE log_facet_buckets (
  workspace_id text NOT NULL, generation text NOT NULL, grain text NOT NULL, bucket_at timestamptz NOT NULL,
  region text NOT NULL, band text NOT NULL, status text NOT NULL, n bigint NOT NULL,
  PRIMARY KEY (workspace_id,generation,grain,bucket_at,region,band,status)
);
CREATE INDEX log_facet_buckets_region ON log_facet_buckets(workspace_id,generation,region,grain,bucket_at);
