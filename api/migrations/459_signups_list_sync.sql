SET LOCAL lock_timeout='2s';
-- The sign-ups list (src/signups.ts, NIGHTMAIL_SIGNUPS_LIST_ID). list_synced_at: what was last written to the platform
-- workspace's list, a waitlist row's version (the later of last_at and let_in_at) or the time a sign-up was written; null
-- until then, so every row is due once the list is set. A sign-up keeps what admission proved and what the waitlist row
-- it consumed said, so its contact never reads the account's later profile: email is the mailbox the sign-in proved,
-- name the one it gave, joined_at, attempts and let_in_at the waitlist row's. Sign-ups before this have none, and stay
-- off the list. Both tables are small; nothing is rewritten.
ALTER TABLE nightmail_waitlist ADD COLUMN list_synced_at timestamptz;
ALTER TABLE nightmail_signups ADD COLUMN list_synced_at timestamptz,
  ADD COLUMN email text CHECK (email = lower(email) AND length(email) <= 320),
  ADD COLUMN name text CHECK (length(name) <= 200),
  ADD COLUMN joined_at timestamptz,
  ADD COLUMN attempts integer,
  ADD COLUMN let_in_at timestamptz;
CREATE INDEX nightmail_signups_email ON nightmail_signups(email) WHERE email IS NOT NULL;
