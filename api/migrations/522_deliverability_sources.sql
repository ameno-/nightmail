SET LOCAL lock_timeout = '2s';
-- The other sources of Glass's Deliverability board (src/glass-deliverability.ts):
-- provider_account_limits: what GetAccount says of the account's health in each region, written with its quota sample
--   (dispatcher.ts ensureQuota): SES's enforcement status (HEALTHY, PROBATION, SHUTDOWN), whether sending and
--   production access are on, and whether Virtual Deliverability Manager and its engagement metrics are.
-- deliverability_vdm_daily: VDM's daily figures per region, ISP (as Amazon names it; '' is every ISP) and metric (SEND,
--   DELIVERY, PERMANENT_BOUNCE, TRANSIENT_BOUNCE, COMPLAINT, DELIVERY_COMPLAINT, OPEN, DELIVERY_OPEN, CLICK,
--   DELIVERY_CLICK), read hourly with BatchGetMetricData. Amazon's estimates, not counts of this installation's mail.
-- deliverability_checks: the latest check of each source by kind and subject (vdm: a region; dbl: one of the
--   platform's domains on Spamhaus DBL), with next_at as the election of the one process that runs the next.
ALTER TABLE provider_account_limits ADD COLUMN enforcement_status text, ADD COLUMN sending_enabled boolean,
  ADD COLUMN production_access boolean, ADD COLUMN vdm_enabled boolean, ADD COLUMN vdm_engagement boolean;
CREATE TABLE deliverability_vdm_daily (
  region text NOT NULL, day date NOT NULL, isp text NOT NULL, metric text NOT NULL, value double precision NOT NULL,
  fetched_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (region, day, isp, metric)
);
CREATE TABLE deliverability_checks (
  kind text NOT NULL CHECK (kind IN ('vdm', 'dbl')), subject text NOT NULL,
  status text, detail jsonb, checked_at timestamptz, next_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (kind, subject)
);
