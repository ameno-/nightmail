SET LOCAL lock_timeout='2s';
-- Sign-in links (hosted; src/signups.ts): an address an operator's raise let in, whose person's sign-in proves no
-- mailbox for it (a GitHub account without it verified, a Google account on another address), can have a link emailed
-- to it. Following the link and then signing in, with any method, takes the place held for that address. One row per
-- link, deleted by the sign-in it admits: it works once, until expires_at. The row holds no secret: the link carries
-- its ID and an HMAC of the ID under a key derived from the root secret.
CREATE TABLE nightmail_signin_links (
  id text PRIMARY KEY CHECK (length(id) <= 64),
  email text NOT NULL CHECK (email = lower(email) AND length(email) <= 320),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);
CREATE INDEX nightmail_signin_links_email ON nightmail_signin_links(email, created_at);
-- Kept a day for the daily count, then removed by maintenance.ts.
CREATE INDEX nightmail_signin_links_created ON nightmail_signin_links(created_at);
