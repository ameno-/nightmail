SET LOCAL lock_timeout = '2s';
-- Agent feedback is its message alone (src/feedback.ts): severity and kind are no longer asked for or written. The columns
-- stay, nullable, so a Worker still on the previous version keeps filing reports while this one deploys; no report was
-- ever filed with them in production. Glass's activity feed now shows every report, newest first, not only critical ones.
ALTER TABLE support_feedback ALTER COLUMN severity DROP NOT NULL, ALTER COLUMN kind DROP NOT NULL;
DROP INDEX IF EXISTS support_feedback_critical;
CREATE INDEX IF NOT EXISTS support_feedback_created ON support_feedback (created_at);
