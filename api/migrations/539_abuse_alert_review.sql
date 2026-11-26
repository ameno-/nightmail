SET LOCAL lock_timeout='2s';
-- Abuse alerts in Slack, and their review (src/abuse-alerts.ts).
-- members, reasons: what an alert was about (its cluster's members as type:id, and its reason codes), so an alert that
--   was already raised, watched or dismissed is not raised again whatever its cluster's ID becomes. An erasure deletes
--   every alert that names the person.
-- retry_at: when a post that failed is tried again.
-- review: an operator's decision on the alert. watch: reviewed, keep tracking, raise it again only at a higher level.
--   dismiss: not abuse, raise it again only with a member or a reason it did not have. reviewed_by: the operator's user.
ALTER TABLE abuse_alerts
  ADD COLUMN members text[] NOT NULL DEFAULT '{}',
  ADD COLUMN reasons text[] NOT NULL DEFAULT '{}',
  ADD COLUMN retry_at timestamptz,
  ADD COLUMN review text CHECK (review IN ('watch','dismiss')),
  ADD COLUMN reviewed_by text,
  ADD COLUMN reviewed_at timestamptz;
-- The alerts stored before this: about their cluster as it is now (nothing, for a cluster that is gone).
UPDATE abuse_alerts a SET members=ARRAY(SELECT m.entity_type||':'||m.entity_id FROM abuse_cluster_members m WHERE m.cluster_id=a.cluster_id),
  reasons=ARRAY(SELECT r->>'code' FROM abuse_clusters c, jsonb_array_elements(c.reasons) r WHERE c.id=a.cluster_id);
