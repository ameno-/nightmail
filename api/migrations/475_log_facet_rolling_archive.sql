SET LOCAL lock_timeout = '2s';
-- One immutable-at-its-stamp prior per workspace, region and rolling period. This namespace
-- is independent of the legacy source-fold slots/snapshots, including during a rolling deploy.
CREATE TABLE log_facet_rolling (
  workspace_id text NOT NULL,region text NOT NULL,period text NOT NULL,generation text NOT NULL,
  lower_at timestamptz NOT NULL,as_of timestamptz NOT NULL,cut jsonb NOT NULL,
  published_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  PRIMARY KEY (workspace_id,region,period)
);
