SET LOCAL lock_timeout='2s';
-- Abuse monitoring, part 3 (src/abuse-alerts.ts): the alert outbox. One row when a cluster first needs a look, climbs
-- a risk level or gains a member, with the Slack Block Kit card as it would be posted. The card holds no personal
-- data: a risk level, reason codes, workspace IDs and links into the Operator area, which needs a staff sign-in.
-- Rows stay 'stored' until a Slack webhook is configured (ABUSE_SLACK_WEBHOOK_URL); operators read them either way.
CREATE TABLE abuse_alerts (
  id text PRIMARY KEY CHECK (id ~ '^aal_[0-9a-f]{24}$'),
  cluster_id text NOT NULL,
  band text NOT NULL CHECK (band IN ('review','high')),
  score smallint NOT NULL CHECK (score BETWEEN 0 AND 100),
  kind text NOT NULL CHECK (kind IN ('new','raised','grew')),
  workspaces integer NOT NULL CHECK (workspaces >= 0),
  payload jsonb NOT NULL CHECK (octet_length(payload::text) <= 16000),
  status text NOT NULL DEFAULT 'stored' CHECK (status IN ('stored','sent','failed')),
  attempts integer NOT NULL DEFAULT 0,
  error text CHECK (length(error) <= 40),
  created_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz
);
CREATE INDEX abuse_alerts_page ON abuse_alerts(created_at DESC, id DESC);
CREATE INDEX abuse_alerts_cluster ON abuse_alerts(cluster_id, band, created_at DESC);
CREATE INDEX abuse_alerts_due ON abuse_alerts(created_at) WHERE status='stored';
