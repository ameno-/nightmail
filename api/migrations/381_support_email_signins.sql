-- Support email sign-ins, mailbox proofs and bindings (src/support-conversations.ts, api/README.md "Support integration").
-- Internal: customers never read these rows; they only confirm their own message, signed in.
--
-- A message at a support address that doesn't bind its sender's account (no DMARC pass, an ambiguous From, or an address
-- that matches an account only up to case) gets the fixed reply with a sign-in link for that one message. Registration
-- records it here. The person whose current verified email is the sender's address confirms it signed in
-- (POST /v1/support-conversations/{id}/claim with this message's ID): that binds the conversation to them when nobody is
-- bound yet, and records the sign-in for this message only, also when the conversation is already theirs. The support
-- platform answers exactly the messages its scope lists as signed in, once each.
CREATE TABLE support_email_signins (
  conversation_id text NOT NULL REFERENCES support_conversations(id) ON DELETE CASCADE,
  message_id text NOT NULL CHECK (message_id ~ '^msg_[0-9a-f]{32}$'),
  -- The sender's address as registration read it from the stored message (the conversation's one sender).
  address text NOT NULL CHECK (length(address) <= 254),
  created_at timestamptz NOT NULL DEFAULT now(),
  -- Who confirmed it, signed in, and when: set once.
  user_id text,
  signed_in_at timestamptz,
  CHECK ((user_id IS NULL) = (signed_in_at IS NULL)),
  PRIMARY KEY (conversation_id, message_id)
);

-- Unsigned sign-ins go after 7 days (src/maintenance.ts), when a claim is refused anyway.
CREATE INDEX support_email_signins_unsigned ON support_email_signins (created_at) WHERE signed_in_at IS NULL;

-- When a sign-in last proved that the person reads the account's address as a mailbox now (account-policy.ts
-- provenMailbox: hosted, a Google-hosted mailbox), and which address it proved. Email support binds an account, and an
-- answer written from it is sent, only within MAILBOX_PROOF_DAYS of such a proof of the address the account has now
-- (account-policy.ts mailboxProven). An address only "verified once" (GitHub, another provider's address) proves nothing.
ALTER TABLE nightmail_users ADD COLUMN mailbox_proved text CHECK (length(mailbox_proved) <= 320), ADD COLUMN mailbox_proved_at timestamptz;

-- People already signed in when this ships: a live session whose own sign-in proved the account's address a mailbox counts
-- as that proof, so they can continue an emailed request without signing in again. The session's verified_email alone
-- isn't enough: until sign-in applied provenMailbox it held any verified address, a GitHub one too, and a session doesn't
-- record its method. The sign-in log does (nightmail_signin_attempts, one row per subject, written right after the session):
-- the session must be its subject's latest sign-in, and that sign-in a Google one (acr and provider google) for a
-- Google-hosted address, as provenMailbox requires: a Workspace account's address at its own domain (hd), or else a Gmail
-- address. GitHub, email-link and password sessions, expired ones, and addresses that aren't the account's verified email
-- (in any case, as mailboxProven compares) record nothing. Idempotent; a recorded proof only moves later.
UPDATE nightmail_users u SET mailbox_proved = p.address, mailbox_proved_at = p.signed_in
FROM (
  SELECT DISTINCT ON (s.user_id) s.user_id, lower(s.verified_email) AS address, s.expires_at - interval '7 days' AS signed_in
  FROM nightmail_sessions s
  JOIN nightmail_signin_attempts a ON a.issuer = s.issuer AND a.subject = s.subject
  WHERE s.verified_email IS NOT NULL AND s.expires_at > now()
    AND starts_with(a.outcome, 'signed_in') AND a.acr = 'urn:anomaly:acr:google' AND a.provider = 'google'
    AND a.last_at >= s.expires_at - interval '7 days' AND a.last_at < s.expires_at - interval '7 days' + interval '5 minutes'
    AND (lower(split_part(s.verified_email, '@', 2)) = lower(a.provider_hd)
      OR (a.provider_hd IS NULL AND lower(split_part(s.verified_email, '@', 2)) IN ('gmail.com', 'googlemail.com')))
  ORDER BY s.user_id, s.expires_at DESC
) p
WHERE p.user_id = u.id AND u.email_verified AND lower(u.email) = p.address AND (u.mailbox_proved_at IS NULL OR u.mailbox_proved_at < p.signed_in);

-- Each message that bound an account by email, by its Message-ID: another delivery of the same message (a replay of a
-- signed copy) never binds that account again. Rows go after 7 days (src/maintenance.ts); by then a replay's Date is
-- too old to bind anyway.
CREATE TABLE support_email_bindings (
  user_id text NOT NULL REFERENCES nightmail_users(id) ON DELETE CASCADE,
  rfc_message_id text NOT NULL CHECK (length(rfc_message_id) <= 998),
  message_id text NOT NULL CHECK (message_id ~ '^msg_[0-9a-f]{32}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, rfc_message_id)
);
CREATE INDEX support_email_bindings_created ON support_email_bindings (created_at);
