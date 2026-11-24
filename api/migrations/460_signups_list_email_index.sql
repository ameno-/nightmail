-- bane:no-transaction
CREATE INDEX CONCURRENTLY IF NOT EXISTS nightmail_signups_email ON nightmail_signups(email) WHERE email IS NOT NULL;
