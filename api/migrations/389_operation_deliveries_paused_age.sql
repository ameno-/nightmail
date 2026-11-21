-- bane:no-transaction
-- Retention dead-letters deliveries held 30 days for a paused endpoint, oldest first, 5,000 at a time (maintenance.ts
-- operation_deliveries_paused_expired). No index gave that order (operation_deliveries_retire leaves paused rows out), so
-- each batch read and sorted every parked delivery. Built concurrently: deliveries keep writing meanwhile.
CREATE INDEX CONCURRENTLY IF NOT EXISTS operation_deliveries_paused_age ON operation_deliveries (created_at) WHERE status = 'paused';
