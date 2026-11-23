-- Track feedback queue backlog lag per lane (routine vs priority) so campaign health checks can avoid sending blind
-- when safety feedback (bounces, complaints, unsubscribes) is stale, and the campaign page can show delivery-stats lag.
CREATE TABLE IF NOT EXISTS operation_feedback_lag (
  lane text PRIMARY KEY CHECK (lane IN ('routine', 'priority')),
  depth integer NOT NULL DEFAULT 0,
  oldest_ms integer NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Allow waiting_reason = 'feedback_lag' when releaseStep holds a campaign on stale priority feedback.
ALTER TABLE sending_campaigns
  DROP CONSTRAINT IF EXISTS sending_campaigns_waiting_reason_check,
  ADD CONSTRAINT sending_campaigns_waiting_reason_check CHECK (
    waiting_reason IN ('pacing_window','ses_daily_quota','hosted_daily_quota','list_probe','balance','feedback_lag')
  ) NOT VALID;
ALTER TABLE sending_campaigns VALIDATE CONSTRAINT sending_campaigns_waiting_reason_check;
