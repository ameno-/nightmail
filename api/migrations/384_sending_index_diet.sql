-- bane:no-transaction
-- Fewer indexes on sending_emails: a status change is not a HOT update, so it writes an entry into every index.
-- sending_emails_page (workspace_id, id) only answered point lookups by (workspace_id, id), about two entries read per
-- scan; sending_emails_pkey (id) answers each with one unique probe and checks the workspace on that row.
-- sending_emails_review_recipient held a NULL entry for every direct email. sending_emails_review_ordinal keeps the same
-- uniqueness for campaign rows (a review recipient is released once; the release INSERT names no ON CONFLICT target),
-- and serves retention's review_id lookups, whose = implies review_id IS NOT NULL.
-- No query reads through operation_events_metrics, operation_sns_receipts_retention, jobs_workspace_due_idx or the two
-- label GINs: operation_events reads use its primary key, operation_events_email_metrics or operation_events_retire;
-- receipts their primary key or operation_sns_receipts_retire; jobs filtered by status jobs_due_idx or jobs_ready_page;
-- labels are only tested with = ANY, which a GIN cannot answer. The one jobs read that used only the workspace prefix,
-- the hourly reputation-alert ledger (reputation-alerts.ts, newest first within a workspace), gets jobs_reputation_ledger.
-- Each replacement is built (and rebuilt if an earlier build was interrupted) before the index it replaces goes.
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS sending_emails_review_ordinal ON sending_emails(review_id,review_ordinal) WHERE review_id IS NOT NULL;
CREATE INDEX CONCURRENTLY IF NOT EXISTS jobs_reputation_ledger ON jobs(workspace_id,created_at DESC) WHERE type='reputation.alert';
DROP INDEX CONCURRENTLY IF EXISTS sending_emails_review_recipient;
DROP INDEX CONCURRENTLY IF EXISTS sending_emails_page;
DROP INDEX CONCURRENTLY IF EXISTS operation_events_metrics;
DROP INDEX CONCURRENTLY IF EXISTS operation_sns_receipts_retention;
DROP INDEX CONCURRENTLY IF EXISTS jobs_workspace_due_idx;
DROP INDEX CONCURRENTLY IF EXISTS mailbox_messages_labels;
DROP INDEX CONCURRENTLY IF EXISTS mailbox_threads_labels;
