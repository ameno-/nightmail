-- bane:no-transaction
-- Contract step for migrations 326 and 327 (several receiving hosts per domain). mailbox_domains_receiving_host kept a
-- routing host unique within one workspace; mailbox_domains_routing_host (327) keeps it unique across every workspace,
-- on the same rows, so it refuses everything the older index refused. Every reader that could use the older index can
-- use the newer one: it leads with receiving_host and has the same predicate. The Worker running while this applies
-- (#363) already maps a conflict on either index to RECEIVING_HOST_TAKEN. An index holds no data.
-- The first line confirms the replacement is there and valid (rebuilt online if a build was interrupted) before the
-- older index goes.
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS mailbox_domains_routing_host ON mailbox_domains(receiving_host) WHERE receiving_host IS NOT NULL AND status IN ('active','provisioning');
DROP INDEX CONCURRENTLY IF EXISTS mailbox_domains_receiving_host;
