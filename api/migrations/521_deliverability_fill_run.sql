-- bane:batched
-- Backfills deliverability_hourly six hours of mail at a time (deliverability_fill_page, migration 520). Idempotent.
SELECT deliverability_fill_page($1) AS cursor;
