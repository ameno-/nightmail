-- bane:no-transaction
-- Partial index covering only rows held awaiting background content screening (screened = false).
-- Empty during normal operation (zero write amplification on screened=true sends), while keeping
-- screenHeldMail leases and held-backlog counts O(held) even when a large campaign is queued.
CREATE INDEX CONCURRENTLY IF NOT EXISTS sending_emails_held_screen ON sending_emails (created_at, id) WHERE NOT screened AND status IN ('queued', 'scheduled');
