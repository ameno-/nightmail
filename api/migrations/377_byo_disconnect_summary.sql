SET LOCAL lock_timeout='1s';
-- What a connected account's disconnect keeps and couldn't remove (byo-regional.ts): recorded when sending is fenced.
ALTER TABLE provider_connections ADD COLUMN disconnect_summary jsonb;
