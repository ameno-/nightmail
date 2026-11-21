-- Undo for the support inbox's Mark done (src/support-inbox.ts): the ticket that Done resolved, if any, so Undo reopens
-- that ticket and never one resolved another way. Expand-only: nullable, and written only by Done and its Undo.
ALTER TABLE support_conversations ADD COLUMN done_ticket_id text;
