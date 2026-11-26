SET LOCAL lock_timeout = '2s';
-- An agent's report that asks something is answered by email to a person (src/feedback.ts, src/feedback-triage.ts):
-- the person behind the credential that filed it, or for an API key the workspace's longest-standing owner, at their
-- account's verified address, never one from the call. Expand-only.
--
-- support_feedback.answer_to: that person, chosen when the report is filed (null: nobody may be emailed).
-- answer: what the report's filer was told: 'email' (answered if it needs an answer), 'nobody' or 'capped' (no answer).
-- answer_state: 'waiting' until the triage agent reads it; then 'due' (it asks something: answer_conversation_id is the
-- email conversation that answers it), 'not_needed' (a bug report or a gap in the docs), 'capped' (a day's answers
-- were used up meanwhile), 'nobody' (its person left the workspace or lost the verified address meanwhile) or
-- 'started' (the support platform took it).
ALTER TABLE support_feedback
  ADD COLUMN IF NOT EXISTS answer_to text,
  ADD COLUMN IF NOT EXISTS answer text CHECK (answer IN ('email', 'nobody', 'capped')),
  ADD COLUMN IF NOT EXISTS answer_state text CHECK (answer_state IN ('waiting', 'due', 'not_needed', 'capped', 'nobody', 'started')),
  ADD COLUMN IF NOT EXISTS answer_conversation_id text,
  ADD COLUMN IF NOT EXISTS answer_claimed_at timestamptz,
  ADD COLUMN IF NOT EXISTS answer_attempts integer NOT NULL DEFAULT 0 CHECK (answer_attempts >= 0);
-- The day's answers per credential, per workspace and in all (FEEDBACK_ANSWERS), and the support platform's due list.
CREATE INDEX IF NOT EXISTS support_feedback_answers ON support_feedback (created_at) WHERE answer = 'email';
CREATE INDEX IF NOT EXISTS support_feedback_answer_due ON support_feedback (created_at) WHERE answer_state IN ('due', 'started');

-- The email conversation that answers it is the person's, verification 'agent': Nightmail vouches for whom it is for
-- (an account it addressed itself), and a reply from that account's address continues it as any email does.
ALTER TABLE support_conversations DROP CONSTRAINT IF EXISTS support_conversations_verification;
ALTER TABLE support_conversations DROP CONSTRAINT IF EXISTS support_conversations_binding;
ALTER TABLE support_conversations
  ADD CONSTRAINT support_conversations_verification CHECK (verification IN ('handoff', 'dmarc', 'signin', 'none', 'credential', 'agent')),
  ADD CONSTRAINT support_conversations_binding CHECK (CASE channel
    WHEN 'chat' THEN verification = 'handoff' AND user_id IS NOT NULL AND workspace_id IS NOT NULL
    WHEN 'email' THEN verification <> 'credential' AND (verification <> 'agent' OR (user_id IS NOT NULL AND mode = 'member' AND workspace_id IS NOT NULL))
    ELSE verification = 'credential' AND mode = 'unverified' AND user_id IS NULL AND workspace_id IS NOT NULL END);
