SET LOCAL lock_timeout='2s';
-- Acquire all metadata locks immediately or roll back without putting sign-ins behind a queued DDL lock.
LOCK TABLE nightmail_waitlist,nightmail_signups,audience_list_members IN ACCESS EXCLUSIVE MODE NOWAIT;
-- The sign-ups list (src/signups.ts, NIGHTMAIL_SIGNUPS_LIST_ID). list_synced_at: what was last written to the platform
-- workspace's list, a waitlist row's version (the later of last_at and let_in_at) or the time a sign-up was written; null
-- until then, so every row is due once the list is set. A sign-up keeps what admission proved and what the waitlist row
-- it consumed said, so its contact never reads the account's later profile: email is the mailbox the sign-in proved,
-- name the one it gave, joined_at, attempts and let_in_at the waitlist row's. Sign-ups before this have none, and stay
-- off the list. Both tables are small; nothing is rewritten.
ALTER TABLE audience_list_members ADD COLUMN signup_waitlist boolean;
ALTER TABLE nightmail_waitlist ADD COLUMN list_synced_at timestamptz, ADD COLUMN list_synced_attempts integer;
ALTER TABLE nightmail_signups ADD COLUMN list_synced_at timestamptz,
  ADD COLUMN email text,
  ADD COLUMN name text,
  ADD COLUMN joined_at timestamptz,
  ADD COLUMN attempts integer,
  ADD COLUMN let_in_at timestamptz;
-- All pre-migration rows have NULL in these new columns. Enforce on writes without scanning the old rows
-- under ACCESS EXCLUSIVE; the partial index is built online after this transaction releases the locks.
ALTER TABLE nightmail_signups
  ADD CONSTRAINT nightmail_signups_email_check CHECK (email = lower(email) AND length(email) <= 320) NOT VALID,
  ADD CONSTRAINT nightmail_signups_name_check CHECK (length(name) <= 200) NOT VALID;
