SET LOCAL lock_timeout='2s';
-- Billing step 2 of 3, first part: when a send's refund last wrote into a usage row. From 334 a refund is written into
-- the hour its mail was metered in, which may have closed long ago; the settler leaves it until the hour it was written
-- in has closed, as it did when refunds went into the current hour. Its own transaction, locking only this table for a
-- column with no default (no rewrite), so it waits for the meter writes in flight and holds nothing else.
ALTER TABLE billing_usage_hourly ADD COLUMN IF NOT EXISTS adjusted_at timestamptz;
