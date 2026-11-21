-- bane:no-transaction
-- 386 lists unsettled hours in billing_open; nothing reads this index any more, and without it meter updates are HOT.
DROP INDEX CONCURRENTLY IF EXISTS billing_usage_open;
