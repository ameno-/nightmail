-- bane:no-transaction
-- Logs: an email sent with sendEmail whose In-Reply-To named a stored message its sender could read joins that
-- message's thread, recorded in its snapshot (threadId, thread-view.ts joinReplies). This finds the emails that joined
-- a thread; only emails that joined one are in it.
CREATE INDEX CONCURRENTLY IF NOT EXISTS sending_emails_reply_thread ON sending_emails(workspace_id,(snapshot->>'threadId')) WHERE snapshot ? 'threadId';
