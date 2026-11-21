-- bane:no-transaction
-- The abuse-monitoring job (src/abuse.ts) reads payment attempts in the order they last changed, a bounded page at a time.
CREATE INDEX CONCURRENTLY IF NOT EXISTS billing_attempts_updated ON billing_payment_attempts(updated_at, id);
