-- Collection only writes objects. All three tables are updated by settled-hour upkeep.
CREATE TABLE analytics_hours (
  hour timestamptz PRIMARY KEY,
  snapshot text NOT NULL, revision integer NOT NULL DEFAULT 1,
  push_after timestamptz, attempts integer NOT NULL DEFAULT 0
);
CREATE INDEX analytics_hours_push_due ON analytics_hours(push_after) WHERE push_after IS NOT NULL;
CREATE TABLE analytics_hourly (
  hour timestamptz NOT NULL REFERENCES analytics_hours(hour) ON DELETE CASCADE,
  metric text NOT NULL, dimensions jsonb NOT NULL, events integer NOT NULL,
  visitor_ids text[] NOT NULL,
  visitors integer GENERATED ALWAYS AS (cardinality(visitor_ids)) STORED,
  PRIMARY KEY(hour, metric, dimensions)
);
CREATE TABLE analytics_funnel_first (
  workspace text NOT NULL, step text NOT NULL, hour timestamptz NOT NULL,
  PRIMARY KEY(workspace, step)
);
CREATE INDEX analytics_funnel_first_hour ON analytics_funnel_first(hour);
