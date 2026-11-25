-- The support inbox's complete timeline (src/support-inbox.ts). Expand-only: every new column is nullable, and nothing
-- the deployed code writes is constrained.
--
-- A message gains the stored email a customer message came from (mail_messages.id at the support address), so the inbox
-- shows the email in full (its quoted history, formatting and attachments) rather than the reply text the support
-- platform kept; why the support platform held an agent answer instead of sending it; and its attachments' names, types
-- and sizes. A staff note is a staff row of kind 'note' with no delivery: it never enters the outbox.
ALTER TABLE support_messages
  ADD COLUMN source_message_id text CHECK (source_message_id ~ '^msg_[0-9a-f]{32}$'),
  ADD COLUMN held_reason text CHECK (held_reason IN ('paused','gate','access','closed','earlier')),
  ADD COLUMN files jsonb CHECK (jsonb_typeof(files) = 'array');

-- The ticket as the agent filed it (title, summary, what the customer asked, its recommendation): shown above the
-- transcript as the AI summary, never in place of it.
ALTER TABLE support_conversations ADD COLUMN ticket_brief jsonb CHECK (jsonb_typeof(ticket_brief) = 'object');

-- What happened to a conversation besides its messages, in order: a ticket filed, its priority changed, the agent paused
-- (by staff or for a ticket) and handed back, a ticket resolved, marked done and undone. Opened and closed come from the
-- conversation's own columns. user_id is the staff member who did it, or null for the support platform. Deleted with the
-- transcript, 90 days after the conversation closed (src/maintenance.ts).
CREATE TABLE support_events (
  id bigserial PRIMARY KEY,
  conversation_id text NOT NULL REFERENCES support_conversations(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind ~ '^[a-z_]{1,32}$'),
  user_id text,
  details jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(details) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX support_events_conversation ON support_events (conversation_id, created_at, id);

-- What the conversations already say about their past.
INSERT INTO support_events(conversation_id, kind, user_id, details, created_at)
SELECT id, 'ticket', NULL, jsonb_build_object('ticketId', ticket_id, 'type', ticket_type, 'severity', ticket_severity), ticket_at FROM support_conversations WHERE ticket_id IS NOT NULL AND ticket_at IS NOT NULL
UNION ALL SELECT id, 'paused', CASE WHEN paused_by <> 'ticket' THEN paused_by END, jsonb_build_object('by', CASE WHEN paused_by = 'ticket' THEN 'ticket' ELSE 'staff' END), paused_at
  FROM support_conversations WHERE agent_state = 'paused' AND paused_at IS NOT NULL
UNION ALL SELECT id, 'resolved', ticket_resolved_by, jsonb_build_object('ticketId', ticket_id), ticket_resolved_at FROM support_conversations WHERE ticket_resolved_at IS NOT NULL
UNION ALL SELECT id, 'done', done_by, '{}'::jsonb, done_at FROM support_conversations WHERE done_at IS NOT NULL;

-- The emails customers already wrote: each customer message of an email conversation is matched to the message its
-- sender sent in that thread at a support address, when the text the support platform kept is in it, the nearest in
-- time first; an email is matched once.
WITH candidate AS (
  SELECT sm.id AS support_id, mm.id AS mail_id,
    row_number() OVER (PARTITION BY sm.id ORDER BY abs(extract(epoch FROM mm.received_at - sm.created_at)), mm.id) AS nearest
  FROM support_messages sm
  JOIN support_conversations c ON c.id = sm.conversation_id AND c.channel = 'email' AND c.thread_id IS NOT NULL
  JOIN mail_messages ev ON ev.id = c.evidence->>'message'
  CROSS JOIN LATERAL (SELECT DISTINCT mb.message_id FROM mailbox_messages mb WHERE mb.workspace_id = ev.workspace_id AND mb.thread_id = c.thread_id AND mb.direction = 'inbound'
    AND mb.received_at BETWEEN sm.created_at - interval '7 days' AND sm.created_at + interval '5 minutes') mb
  JOIN mail_messages mm ON mm.id = mb.message_id AND lower(mm.from_address) = lower(ev.from_address)
  WHERE sm.author = 'customer' AND sm.source_message_id IS NULL AND length(btrim(sm.text)) >= 8
    AND strpos(regexp_replace(coalesce(mm.text, ''), '\s+', ' ', 'g'), left(regexp_replace(btrim(sm.text), '\s+', ' ', 'g'), 60)) > 0
), picked AS (
  SELECT DISTINCT ON (mail_id) support_id, mail_id FROM candidate WHERE nearest = 1 ORDER BY mail_id, support_id
)
UPDATE support_messages sm SET source_message_id = picked.mail_id FROM picked WHERE sm.id = picked.support_id;
