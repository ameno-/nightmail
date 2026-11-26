-- Support sign-in links (src/support-conversations.ts): a person whose sign-in proves no mailbox (GitHub, say) can have
-- a sign-in link emailed to the address a support email came from, from that email's Continue page. Following it and
-- signing in with the account for that address proves its mailbox (account-login.ts), and the page opens again to confirm
-- the email. Such a row names its conversation and message; a waitlist link's (migration 466) names neither. Each kind is
-- counted and spent on its own (signups.ts).
SET LOCAL lock_timeout = '2s';
ALTER TABLE nightmail_signin_links ADD COLUMN IF NOT EXISTS conversation_id text, ADD COLUMN IF NOT EXISTS message_id text;
ALTER TABLE nightmail_signin_links DROP CONSTRAINT IF EXISTS nightmail_signin_links_support;
ALTER TABLE nightmail_signin_links ADD CONSTRAINT nightmail_signin_links_support CHECK ((conversation_id IS NULL) = (message_id IS NULL));
-- The daily count per conversation.
CREATE INDEX IF NOT EXISTS nightmail_signin_links_conversation ON nightmail_signin_links (conversation_id, created_at) WHERE conversation_id IS NOT NULL;
