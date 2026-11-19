-- The growth pace is for new senders only (src/standing-model.ts ESTABLISHED). A workspace's own sending counts as a
-- track record only when SES accepted it before this baseline: the pace's rollout (migration 348) for the workspaces
-- that existed then. Workspaces created later have none, so only an operator override or lift exempts them.
ALTER TABLE sender_standing ADD COLUMN history_before timestamptz;
COMMENT ON COLUMN sender_standing.history_before IS 'Mail SES accepted before this counts as a track record that skips the growth pace; NULL: none (a new sender).';
DO $$ DECLARE rollout timestamptz; BEGIN
  IF to_regclass('nightmail_migrations') IS NOT NULL THEN SELECT applied_at INTO rollout FROM nightmail_migrations WHERE name='348_no_daily_cap.sql'; END IF;
  UPDATE sender_standing SET history_before=coalesce(rollout,now());
END $$;
