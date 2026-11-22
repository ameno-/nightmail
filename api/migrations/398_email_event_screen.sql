-- The content screen's verdict on a refused email (the classifier's score, its model and the threshold it was held to),
-- for operators and support (src/operator.ts, src/deliverability.ts screenActivity). It was written into the reject
-- event's data, and data is what the API returns and what a webhook is sent, so senders could read how close they were
-- and which model judged them. It now has its own column, which nothing outward reads: not the API, the SDK, MCP, the
-- dashboard or a webhook. Null on every event but a screen refusal.
-- Events stored before this keep data->'screen' until they expire (30 days): the two readers of the verdict fall back
-- to it, and every outward read and webhook post removes it (src/core.ts withoutVerdict), as they do for the copies in
-- operation_events and operation_deliveries. Nothing stored is rewritten here.
-- A nullable column without a default: a catalog change only, under a short lock that gives up rather than queue.
SET LOCAL lock_timeout='2s';
ALTER TABLE sending_email_events ADD COLUMN screen jsonb;
