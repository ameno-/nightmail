-- A campaign's outcome counts as its background count stored them (src/sending.ts campaignStatsJob): GET
-- /v1/campaigns/{id}/stats answers a large campaign from them instead of aggregating every email and event, and a
-- finished campaign keeps them after its emails leave the 30-day history. A nullable column without a default: a
-- catalog change, no rewrite, under a short lock that gives up rather than queue behind a long transaction.
SET LOCAL lock_timeout='2s';
ALTER TABLE sending_campaigns ADD COLUMN stats jsonb;
