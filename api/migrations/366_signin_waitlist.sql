SET LOCAL lock_timeout='2s';
-- The waitlist (hosted): a verified Google sign-in that nothing admitted (not staff, no invitation) is told Nightmail
-- isn't open yet and that we'll email its address when it is. One row per address, lowercased, with the name the
-- sign-in gave and every attempt counted. It admits nobody and links nothing: identity stays (issuer, subject).
-- Operators read it at /v1/operator/waitlist. A row leaves when a sign-in with its address is admitted, when the
-- launch email reaches it, or a year after its last attempt (maintenance.ts).
CREATE TABLE nightmail_waitlist (
  email text PRIMARY KEY CHECK (email = lower(email) AND length(email) <= 320),
  name text CHECK (length(name) <= 200),
  attempts integer NOT NULL DEFAULT 1 CHECK (attempts > 0),
  first_at timestamptz NOT NULL DEFAULT now(),
  last_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX nightmail_waitlist_last ON nightmail_waitlist(last_at);

-- Everyone the sign-in log (kept 30 days) still holds as refused for want of an invitation, unless their address is
-- already a verified user's.
INSERT INTO nightmail_waitlist(email,name,attempts,first_at,last_at)
SELECT lower(a.email),(array_agg(a.name ORDER BY a.last_at DESC) FILTER (WHERE a.name IS NOT NULL))[1],sum(a.attempts)::int,min(a.first_at),max(a.last_at)
FROM nightmail_signin_attempts a
WHERE a.outcome='not_approved' AND a.email IS NOT NULL AND length(a.email)<=320
  AND NOT EXISTS (SELECT FROM nightmail_users u WHERE u.email_verified AND lower(u.email)=lower(a.email))
GROUP BY lower(a.email)
ON CONFLICT (email) DO NOTHING;
