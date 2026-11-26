SET LOCAL lock_timeout = '2s';
-- A staff member's agent in the support inbox (src/support-agents.ts). An agent signed in over MCP as an operator asks
-- first: its call opens a request with a code and a link, for 15 minutes. The same person approves it from a dashboard
-- session that passed the staff check, and the approval lets that one connection read the inbox, reply, note, mark done
-- and hand back as them, for 30 days, until they revoke it or lose the operator role.
-- A connection is its approval (nightmail_resource_grants.id, kept across token refreshes) and the account service's
-- consent behind its sign-in (the first part of its tokens' jti), so another install of the same client, or signing in
-- again, is another connection. No foreign key on grant_id: reconnecting after a revocation gives the approval a new ID,
-- and nothing approved for the old one may follow it.
CREATE TABLE support_agent_requests (
  id text PRIMARY KEY,
  user_code text NOT NULL UNIQUE CHECK (user_code ~ '^[BCDFGHJKLMNPQRSTVWXZ]{8}$'),
  grant_id text NOT NULL CHECK (length(grant_id) <= 200),
  consent text NOT NULL CHECK (length(consent) <= 200),
  user_id text NOT NULL REFERENCES nightmail_users(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','denied')),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  decided_at timestamptz
);
CREATE INDEX support_agent_requests_connection ON support_agent_requests(grant_id, consent, created_at DESC);
CREATE TABLE support_agent_approvals (
  id text PRIMARY KEY CHECK (id ~ '^sag_[a-z2-7]{26}$'),
  grant_id text NOT NULL CHECK (length(grant_id) <= 200),
  consent text NOT NULL CHECK (length(consent) <= 200),
  user_id text NOT NULL REFERENCES nightmail_users(id) ON DELETE CASCADE,
  approved_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  last_used_at timestamptz
);
CREATE UNIQUE INDEX support_agent_approvals_live ON support_agent_approvals(grant_id, consent) WHERE revoked_at IS NULL;
CREATE INDEX support_agent_approvals_user ON support_agent_approvals(user_id, approved_at DESC);
-- A staff reply or note an agent wrote for its person: the approval it used. Staff see "via agent"; the customer never does.
ALTER TABLE support_messages ADD COLUMN agent_approval_id text CHECK (agent_approval_id ~ '^sag_[a-z2-7]{26}$');
