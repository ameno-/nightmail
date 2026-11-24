-- Only private read-model objects. No source change, backfill or source-table lock.
SET LOCAL lock_timeout = '2s';

CREATE TABLE log_facet_generations (
  workspace_id text PRIMARY KEY,generation text NOT NULL,capture_signature text NOT NULL,born_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  certified_at timestamptz,next_at timestamptz NOT NULL DEFAULT statement_timestamp()
);
CREATE INDEX log_facet_generation_turn ON log_facet_generations(next_at,workspace_id);
CREATE TABLE log_facet_gaps (
  scope_kind text NOT NULL,scope_key text NOT NULL,lost_at timestamptz NOT NULL,
  PRIMARY KEY (scope_kind,scope_key)
);
CREATE TABLE log_facet_retired_generations (
  workspace_id text NOT NULL,generation text NOT NULL,retired_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  PRIMARY KEY (workspace_id,generation)
);
CREATE INDEX log_facet_retired_turn ON log_facet_retired_generations(retired_at,workspace_id,generation);
CREATE INDEX log_facet_box_age ON log_facet_box_work(captured_at,box_id);
CREATE INDEX log_facet_fact_horizon ON log_facet_message_facts(workspace_id,generation,minute,message_id);
CREATE INDEX log_facet_deadline_horizon ON log_facet_deadlines(workspace_id,generation,minute);
CREATE INDEX log_facet_deadline_zero ON log_facet_deadlines(workspace_id,generation,deadline) WHERE n=0;
CREATE INDEX log_facet_bucket_zero ON log_facet_buckets(workspace_id,generation,grain,bucket_at) WHERE n=0;

-- Demand and publication are separate rows. An arrival during a sealed worker snapshot does
-- not update the row the worker must publish, invalidate an older ticket, or restart the cut.
CREATE TABLE log_facet_demands (
  workspace_id text NOT NULL,region text NOT NULL,period text NOT NULL,anchor timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),wanted_at timestamptz NOT NULL,expires_at timestamptz NOT NULL,
  PRIMARY KEY (workspace_id,region,period,anchor)
);
CREATE INDEX log_facet_demand_expiry ON log_facet_demands(expires_at);
CREATE TABLE log_facet_results (
  workspace_id text NOT NULL,region text NOT NULL,period text NOT NULL,anchor timestamptz NOT NULL,
  generation text NOT NULL,as_of timestamptz NOT NULL,cut jsonb NOT NULL,expires_at timestamptz NOT NULL,
  PRIMARY KEY (workspace_id,region,period,anchor)
);
CREATE INDEX log_facet_result_expiry ON log_facet_results(expires_at);
-- A hint, distinct from both the demand and its numerical publication. Losing a hint is safe:
-- the next scheduled workspace turn and live probe can recover it.
CREATE TABLE log_facet_wakes (
  workspace_id text PRIMARY KEY,requested_at timestamptz NOT NULL DEFAULT statement_timestamp()
);
CREATE INDEX log_facet_wake_order ON log_facet_wakes(requested_at,workspace_id);
