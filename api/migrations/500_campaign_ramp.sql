-- The campaign ramp (src/standing-model.ts RAMP, src/sending.ts releaseStep): a Hosted sender's first large campaigns
-- release in hourly steps that grow, each step checked before the next. Per campaign: the step (an index into the ramp's
-- steps, their count once past the last), when the current step's hour started (null before its first release) and the
-- review ordinal it started at. NULL ramp_step: not placed yet (or no ramp applies). Releasing waits with
-- waiting_reason = 'ramp' while a step's hour is used up or its batch's delivery results are still coming in.
-- Send readiness: the recommended plan's daily batches a campaign launched with (pace_plan, one 24-hour window each, the
-- last repeating), which window it is in (window_index, from 0), the largest daily limit that counts as a ramp when the
-- review required one (ramp_required_cap) and the consent source its sender confirmed instead (consent).
-- Guarded with SET LOCAL lock_timeout = '2s' in a retry loop (as migration 430) so it never queues ACCESS EXCLUSIVE behind
-- a long campaign transaction; the new columns are metadata-only (NULL, or a constant default).
DO $$
BEGIN
  FOR attempt IN 1..60 LOOP
    BEGIN
      SET LOCAL lock_timeout = '2s';
      ALTER TABLE sending_campaigns
        ADD COLUMN IF NOT EXISTS ramp_step smallint,
        ADD COLUMN IF NOT EXISTS ramp_window_started_at timestamptz,
        ADD COLUMN IF NOT EXISTS ramp_from integer NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS pace_plan integer[],
        ADD COLUMN IF NOT EXISTS window_index integer NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS ramp_required_cap integer,
        ADD COLUMN IF NOT EXISTS consent jsonb,
        DROP CONSTRAINT IF EXISTS sending_campaigns_waiting_reason_check,
        ADD CONSTRAINT sending_campaigns_waiting_reason_check CHECK (
          waiting_reason IN ('pacing_window','ses_daily_quota','hosted_daily_quota','list_probe','balance','feedback_lag','ramp')
        ) NOT VALID;
      ALTER TABLE sending_campaigns VALIDATE CONSTRAINT sending_campaigns_waiting_reason_check;
      RETURN;
    EXCEPTION WHEN lock_not_available THEN
      PERFORM pg_sleep(1);
    END;
  END LOOP;
  RAISE EXCEPTION 'sending_campaigns was busy for 3 minutes. Nothing was changed: run the migration again.' USING ERRCODE = 'lock_not_available';
END $$;
