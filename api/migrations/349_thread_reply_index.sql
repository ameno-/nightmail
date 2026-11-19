-- bane:no-transaction
-- Logs: an email sent with sendEmail and an In-Reply-To header joins the conversation of the message it answers
-- (thread-view.ts). This finds the emails that answer a thread's messages; only emails with that header are in it.
CREATE INDEX CONCURRENTLY IF NOT EXISTS sending_emails_in_reply_to ON sending_emails(workspace_id,(btrim(jsonb_path_query_first(snapshot->'headers','$[*] ? (@.Name like_regex "^in-reply-to$" flag "i").Value')#>>'{}','<>'))) WHERE btrim(jsonb_path_query_first(snapshot->'headers','$[*] ? (@.Name like_regex "^in-reply-to$" flag "i").Value')#>>'{}','<>') IS NOT NULL;
