SET LOCAL lock_timeout='2s';
-- A Hosted campaign's list probe can be skipped, not only cleared: a sender in good standing sending to recipients an
-- earlier campaign delivered to (src/sending.ts listMailedCleanly) releases without it. The skip is kept apart from
-- probe_cleared_at, which a probe that went out and passed (or an owner's or operator's release) sets, so a skipped
-- campaign whose sender falls below good standing is probed again on its next release; a passed probe never is.
ALTER TABLE sending_campaigns ADD COLUMN probe_skipped_at timestamptz;
