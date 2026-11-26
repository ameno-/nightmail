SET LOCAL lock_timeout = '2s';
-- Whether an email waiting for its sender's sign-in (src/support-conversations.ts) passed the sender checks a general
-- answer needs: a From that DMARC verified, not sent through Nightmail itself, not a replay. Registration records it from
-- the same checks that make an email `non_member`. Only such an email gets a general answer when nobody claims it within
-- the support platform's claim wait, and only it is owed a reply before a claim (No reply sent, src/support-inbox.ts):
-- forged or unproven mail never makes support write to its sender or wake staff unless the person signs in and claims it.
-- Rows from before this column: false (the sign-in reply settled them, and none gets a general answer).
--
-- general_answer_requested_at: whoever opened the sign-in link emailed to the conversation's address asked to be answered
-- by email instead (releaseGeneralAnswer, once per conversation): from then the conversation is due for a general answer,
-- and its waiting emails are owed one.
ALTER TABLE support_email_signins ADD COLUMN general_answer boolean NOT NULL DEFAULT false, ADD COLUMN general_answer_requested_at timestamptz;
