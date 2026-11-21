-- Support email sign-ins (src/support-conversations.ts, api/README.md "Support integration"). Internal: customers never
-- read these rows; they only confirm their own message, signed in.
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
