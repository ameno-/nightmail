-- The support inbox (src/support-inbox.ts, api/README.md "Support integration"). Internal: operators read it from the
-- dashboard; the support platform writes it through its service binding.
--
-- A conversation gains what the inbox lists: its subject and ticket, whether the agent is paused and by whom (a staff
-- member, or 'ticket' after an emailed ticket), when it last had a message, and the support platform's counters. Its
-- transcript is support_messages: every entry the support platform mirrors, plus the staff replies Nightmail queues
-- for it to deliver. Messages are deleted 90 days after their conversation closes.
ALTER TABLE support_conversations
  ADD COLUMN subject text CHECK (length(subject) <= 200),
  ADD COLUMN ticket_id text CHECK (ticket_id ~ '^tkt_[a-z2-7]{16}$'),
  ADD COLUMN ticket_type text CHECK (ticket_type ~ '^[a-z_]{1,32}$'),
  ADD COLUMN ticket_severity text CHECK (ticket_severity IN ('P1','P2','P3')),
  ADD COLUMN ticket_resolved_at timestamptz,
  ADD COLUMN ticket_resolved_by text,
  ADD COLUMN agent_state text NOT NULL DEFAULT 'active' CHECK (agent_state IN ('active','paused')),
  ADD COLUMN paused_by text,
  ADD COLUMN paused_at timestamptz,
  ADD COLUMN last_message_at timestamptz,
  -- The transcript's length, and the next message's seq: each append takes the row's lock to number it.
  ADD COLUMN messages integer NOT NULL DEFAULT 0 CHECK (messages >= 0),
  ADD COLUMN turns integer NOT NULL DEFAULT 0 CHECK (turns >= 0),
  ADD COLUMN cost_usd numeric(12,4) NOT NULL DEFAULT 0 CHECK (cost_usd >= 0),
  -- Work items the support platform could not finish for this conversation (its "Needs attention").
  ADD COLUMN blocked_work integer NOT NULL DEFAULT 0 CHECK (blocked_work >= 0),
  ADD CONSTRAINT support_conversations_paused CHECK ((agent_state = 'paused') = (paused_by IS NOT NULL AND paused_at IS NOT NULL)),
  ADD CONSTRAINT support_conversations_ticket CHECK (ticket_id IS NOT NULL OR (ticket_type IS NULL AND ticket_severity IS NULL AND ticket_resolved_at IS NULL)),
  ADD CONSTRAINT support_conversations_resolved CHECK ((ticket_resolved_at IS NULL) = (ticket_resolved_by IS NULL));
CREATE INDEX support_conversations_activity ON support_conversations ((coalesce(last_message_at, created_at)) DESC, id DESC);
CREATE INDEX support_conversations_closed ON support_conversations (closed_at) WHERE closed_at IS NOT NULL;

CREATE TABLE support_messages (
  -- The support platform's own message ID (or one Nightmail made for a staff reply): appending it again changes nothing.
  id text PRIMARY KEY CHECK (id ~ '^msg_[a-z2-7]{16}$'),
  conversation_id text NOT NULL REFERENCES support_conversations(id) ON DELETE CASCADE,
  seq integer NOT NULL CHECK (seq > 0),
  author text NOT NULL CHECK (author IN ('customer','agent','staff','system')),
  kind text CHECK (kind ~ '^[a-z_]{1,32}$'),
  text text NOT NULL CHECK (length(text) <= 16000),
  -- The agent's tool calls by label and outcome only, and attachment IDs: never their content.
  tools jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(tools) = 'array'),
  attachments jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(attachments) = 'array'),
  staff_user_id text,
  -- A staff reply: queued until the support platform delivers it. An agent answer: sent, or held (never sent).
  delivery text CHECK (delivery IN ('queued','sent','failed','held')),
  delivered_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (conversation_id, seq),
  CHECK ((author = 'staff') = (staff_user_id IS NOT NULL)),
  CHECK (CASE author WHEN 'staff' THEN delivery IN ('queued','sent','failed') WHEN 'agent' THEN delivery IS NULL OR delivery IN ('sent','failed','held') ELSE delivery IS NULL END)
);
CREATE INDEX support_messages_outbox ON support_messages (created_at, id) WHERE delivery = 'queued';

-- When the support platform last pulled the outbox: staff can reply only while it does (one row).
CREATE TABLE support_outbox_polls (
  id smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  polled_at timestamptz NOT NULL
);
