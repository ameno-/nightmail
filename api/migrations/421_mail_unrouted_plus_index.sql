-- bane:no-transaction
-- Partial expression index so claimUnroutedBatch finds plus-tagged unrouted mail without scanning mail_unrouted.
CREATE INDEX CONCURRENTLY IF NOT EXISTS mail_unrouted_plus_base ON mail_unrouted (workspace_id, regexp_replace(address, '[+][^@]*@', '@')) WHERE strpos(address, '+') > 0;
