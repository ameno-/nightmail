SET LOCAL lock_timeout = '2s';
-- What the support AI spends (src/support-ai-cost.ts): one row each time a model's cost reaches Nightmail. The answering
-- agent's comes with its conversation's counters (the support platform mirrors them, src/support-inbox.ts: the row is
-- what they grew by); the feedback triage agent's after it reads a report (src/feedback-triage.ts). Glass adds the rows
-- up by UTC day, and the health tick compares today's with the daily line (src/health-thresholds.ts SUPPORT_AI).
-- conversation_id has no foreign key: what was spent stays counted after a conversation is deleted.
CREATE TABLE IF NOT EXISTS support_ai_usage (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  at timestamptz NOT NULL DEFAULT now(),
  conversation_id text,
  agent text NOT NULL CHECK (agent IN ('support', 'triage')),
  turns integer NOT NULL DEFAULT 0 CHECK (turns >= 0),
  cost_usd numeric(14, 6) NOT NULL DEFAULT 0 CHECK (cost_usd >= 0)
);
CREATE INDEX IF NOT EXISTS support_ai_usage_at ON support_ai_usage (at);
-- What conversations spent before this table, counted once, on their last message's day.
INSERT INTO support_ai_usage (at, conversation_id, agent, turns, cost_usd)
SELECT coalesce(c.last_message_at, c.created_at), c.id, 'support', c.turns, c.cost_usd FROM support_conversations c
WHERE (c.turns > 0 OR c.cost_usd > 0) AND NOT EXISTS (SELECT FROM support_ai_usage u WHERE u.conversation_id = c.id);
