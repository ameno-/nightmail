SET LOCAL lock_timeout='2s';
-- The sign-up limit (hosted; src/signups.ts): how many accounts may sign up on their own, set by an operator at
-- Operator → Sign-ups. A place is taken by an account that signed up (nightmail_signups) or held for a waiting address
-- an operator's raise let in (nightmail_waitlist.let_in_at). 0, the start, lets nobody in this way: staff, invitations
-- and subjects bound by an operator sign in as before, and everyone else joins the waitlist.
CREATE TABLE nightmail_signup_limit (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  places integer NOT NULL DEFAULT 0 CHECK (places BETWEEN 0 AND 1000000)
);
INSERT INTO nightmail_signup_limit DEFAULT VALUES;

-- One row per account that signed up on its own, written in the transaction that creates the account, so it counts
-- once. via: 'waitlist' took a place a raise held for its address, 'open' one nobody was waiting for.
CREATE TABLE nightmail_signups (
  user_id text PRIMARY KEY REFERENCES nightmail_users(id) ON DELETE CASCADE,
  via text NOT NULL CHECK (via IN ('open','waitlist')),
  at timestamptz NOT NULL DEFAULT now()
);

-- When a raise let this address in: its place is held until a sign-in proving that mailbox takes it. The oldest
-- waiting addresses are let in first.
ALTER TABLE nightmail_waitlist ADD COLUMN let_in_at timestamptz;
CREATE INDEX nightmail_waitlist_queue ON nightmail_waitlist(first_at, email) WHERE let_in_at IS NULL;
