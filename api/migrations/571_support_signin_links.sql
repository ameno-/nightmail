-- Support sign-in links (src/support-conversations.ts): a person whose sign-in proves no mailbox (GitHub, say) can have
-- a sign-in link emailed to the address a support email came from, from that email's Continue page. Following it and
-- signing in with the account for that address proves its mailbox (account-login.ts), and the page opens again to confirm
-- the email. Such a row names its conversation and message; a waitlist link's (migration 466) names neither. Each kind is
-- spent on its own (signups.ts). A link is made only for an address an account has that can confirm the email.
SET LOCAL lock_timeout = '2s';
ALTER TABLE nightmail_signin_links ADD COLUMN IF NOT EXISTS conversation_id text, ADD COLUMN IF NOT EXISTS message_id text;
ALTER TABLE nightmail_signin_links DROP CONSTRAINT IF EXISTS nightmail_signin_links_support;
ALTER TABLE nightmail_signin_links ADD CONSTRAINT nightmail_signin_links_support CHECK ((conversation_id IS NULL) = (message_id IS NULL));
-- Every press of "Email me a sign-in link" counts, whether or not a link was made, so the daily limits (per conversation,
-- per address) refuse alike whether or not an account has the address: link_requests since link_window_at, a day at most.
ALTER TABLE support_email_signins ADD COLUMN IF NOT EXISTS link_requests smallint NOT NULL DEFAULT 0, ADD COLUMN IF NOT EXISTS link_window_at timestamptz;
-- The daily count per address, over its conversations.
CREATE INDEX IF NOT EXISTS support_email_signins_link_requests ON support_email_signins (address, link_window_at) WHERE link_window_at IS NOT NULL;
