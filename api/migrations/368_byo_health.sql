SET LOCAL lock_timeout='1s';
-- The connected account's last health check (byo-regional.ts, byo.health): when it ran and what needs attention.
ALTER TABLE provider_connections ADD COLUMN health jsonb;
