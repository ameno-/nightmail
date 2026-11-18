-- Support conversations (src/support-conversations.ts, api/README.md "Support integration"). Internal: customers never
-- call these routes.
--
-- A conversation is the support platform's chat or email thread (its own conv_… ID), registered with Nightmail. Nightmail
-- alone decides who it is for, from evidence it checks itself: its own signed handoff (chat), the stored From and DMARC
-- verdict of a message it received at a support address (email), or the person's own dashboard session (a claim). Each
-- read the support platform makes for a conversation is stamped with its ID by the service binding, never by a header,
-- and is answered for that user's live memberships, within the conversation's scope, while it is open.
CREATE TABLE support_conversations (
  id text PRIMARY KEY CHECK (id ~ '^conv_[a-z2-7]{26}$'),
  channel text NOT NULL CHECK (channel IN ('chat','email')),
  -- The email thread the support address answers in; null for a chat.
  thread_id text CHECK (length(thread_id) <= 100),
  -- Set only by Nightmail: at registration from its own evidence, or by the person's claim.
  user_id text,
  -- An email conversation's sender: its one address. While no user is bound, the sign-in claim binds the account whose
  -- verified address it is.
  pending_address text CHECK (length(pending_address) <= 254),
  verification text NOT NULL CHECK (verification IN ('handoff','dmarc','signin','none')),
  evidence jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(evidence) = 'object'),
  mode text NOT NULL CHECK (mode IN ('member','non_member','pending_signin','unverified')),
  -- Scope: the one workspace a chat came from or an email narrowed to (null: every membership), and where the
  -- customer let support read message content (a chat only, in its own workspace).
  workspace_id text,
  content_workspace_id text,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','ticketed','closed')),
  -- Requests in the current minute, for the per-conversation rate limit (one UPDATE authenticates, counts and touches).
  window_start timestamptz NOT NULL DEFAULT date_trunc('minute', now()),
  used integer NOT NULL DEFAULT 0,
  last_used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  closed_at timestamptz,
  CHECK ((status = 'closed') = (closed_at IS NOT NULL)),
  CHECK (mode <> 'member' OR user_id IS NOT NULL),
  CHECK (mode NOT IN ('pending_signin','unverified') OR user_id IS NULL),
  CHECK (channel = 'email' OR (verification = 'handoff' AND user_id IS NOT NULL AND workspace_id IS NOT NULL)),
  CHECK (content_workspace_id IS NULL OR (channel = 'chat' AND content_workspace_id = workspace_id))
);
-- At most 10 open conversations per person; the claim and registration count them.
CREATE INDEX support_conversations_user_open ON support_conversations (user_id) WHERE status <> 'closed';

-- A handoff now opens a grant or a conversation, once.
ALTER TABLE support_handoffs ADD COLUMN conversation_id text;
CREATE INDEX support_handoffs_conversation ON support_handoffs (conversation_id) WHERE conversation_id IS NOT NULL;
ALTER TABLE support_handoffs DROP CONSTRAINT support_handoffs_check1;
ALTER TABLE support_handoffs ADD CONSTRAINT support_handoffs_used_once
  CHECK ((used_at IS NULL) = (grant_id IS NULL AND conversation_id IS NULL) AND (grant_id IS NULL OR conversation_id IS NULL));
