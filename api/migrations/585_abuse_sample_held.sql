SET LOCAL lock_timeout='2s';
-- sample_held: how many sample runs in a row set no marks because a session it cannot see the start of held a write
-- lock on sent-mail events (src/abuse.ts sampleBound). Health warns from ABUSE.sampleHeldRuns; the next run that sets
-- marks puts it back to 0. Expand-only.
ALTER TABLE abuse_state ADD COLUMN IF NOT EXISTS sample_held smallint NOT NULL DEFAULT 0 CHECK (sample_held >= 0);
