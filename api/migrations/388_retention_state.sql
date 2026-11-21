-- Retention runs (src/maintenance.ts retire), one row per kind: the hourly run over every table and the 15-minute run
-- over the sent side.
-- - due_at: when the next 15-minute run may start (its election).
-- - lease_until: the run in progress. The 15-minute run stands aside while the hourly one holds it, and two 15-minute runs
--   never overlap. A run that died leaves it for at most its budget and two minutes.
-- - next_step: where the next run starts, the first step the last one's budget didn't reach, so every table gets its turn.
-- - held: sent-side steps whose statement or lock timed out in a 15-minute run, which those runs skip until the hourly run
--   gets through them.
CREATE TABLE IF NOT EXISTS retention_state (
  scope text PRIMARY KEY CHECK (scope IN ('hourly', 'sent')),
  due_at timestamptz,
  lease_until timestamptz,
  next_step text CHECK (length(next_step) <= 100),
  held jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(held) = 'object' AND octet_length(held::text) <= 4000)
);
