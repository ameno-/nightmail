-- A campaign with its own unsubscribe page: each recipient's token remembers the page, so the hosted confirmation
-- continues there after it records the opt-out. NULL for every other token.
ALTER TABLE operation_unsubscribe_tokens ADD COLUMN page_url text;
