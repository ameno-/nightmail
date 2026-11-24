-- The source transaction only appends count-relevant facts. No FK, natural-key conflict, or
-- summary-row update on a mail writer. The identity orders work; it is NOT a commit watermark.
-- The backfill and the consumer run independently, in bounded transactions after installation.
SET LOCAL lock_timeout = '2s';

CREATE TABLE log_facet_changes (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  writer_xid xid8 NOT NULL DEFAULT pg_current_xact_id(),
  captured_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  source text NOT NULL,
  workspace_id text NOT NULL,
  entity_id text,
  minute timestamptz,
  region text,
  kind text,
  status text,
  delta bigint
);
CREATE INDEX log_facet_changes_scope ON log_facet_changes(workspace_id,id);
CREATE INDEX log_facet_changes_age ON log_facet_changes(captured_at,id);
