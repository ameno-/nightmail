-- Private materializer state only. No source write, source-table DDL or inline backfill.
SET LOCAL lock_timeout = '2s';

CREATE TABLE log_facet_inbound_progress (
  workspace_id text NOT NULL, generation text NOT NULL,
  after_at timestamptz, after_id text, seeded boolean NOT NULL DEFAULT false,
  visibility_clock timestamptz NOT NULL DEFAULT statement_timestamp(), advancing_to timestamptz,
  PRIMARY KEY (workspace_id,generation)
);
CREATE TABLE log_facet_message_facts (
  workspace_id text NOT NULL,generation text NOT NULL,message_id text NOT NULL,
  minute timestamptz NOT NULL,region text NOT NULL,spam boolean NOT NULL,
  admin_until timestamptz NOT NULL,member_until timestamptz NOT NULL,
  PRIMARY KEY (workspace_id,generation,message_id)
);
CREATE INDEX log_facet_message_owner ON log_facet_message_facts(message_id,workspace_id,generation);
CREATE TABLE log_facet_deadlines (
  workspace_id text NOT NULL,generation text NOT NULL,deadline timestamptz NOT NULL,minute timestamptz NOT NULL,
  region text NOT NULL,band text NOT NULL,status text NOT NULL,n bigint NOT NULL,
  PRIMARY KEY (workspace_id,generation,deadline,minute,region,band,status)
);
CREATE TABLE log_facet_dirty_messages (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,workspace_id text NOT NULL,generation text NOT NULL,
  message_id text NOT NULL,captured_at timestamptz NOT NULL
);
CREATE INDEX log_facet_dirty_scope ON log_facet_dirty_messages(workspace_id,generation,id);
CREATE INDEX log_facet_dirty_age ON log_facet_dirty_messages(captured_at,id);
CREATE TABLE log_facet_box_work (
  box_id text PRIMARY KEY,after_id text,rerun boolean NOT NULL DEFAULT false,captured_at timestamptz NOT NULL,
  turn_at timestamptz NOT NULL DEFAULT statement_timestamp()
);
CREATE INDEX log_facet_box_turn ON log_facet_box_work(turn_at,box_id);
