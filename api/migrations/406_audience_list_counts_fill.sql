-- Fills audience_list_counts (migration 405) with every list's counts. Its triggers are already committed, so writes made
-- while this runs add their own rows; this statement stores, for each list, the difference between its memberships
-- counted and what is stored, both read in one snapshot. So it is right whatever commits while it runs, it locks
-- nothing a write waits for, and running it again stores nothing.
--
-- Between 405 and this, the table holds only the differences made since the triggers exist. Nothing reads it yet: the
-- release that does is deployed after both migrations, and the one before it counts members itself.
--
-- On a live database this reads audience_list_members and audience_contacts once each, joined by hash, whatever the
-- statistics say. Left to the planner on production (one list, audience_lists never analyzed, so it expected 3,794
-- memberships where there are 1,820,000) it chose one index probe per membership: 56 s on a copy, against 8 s by
-- hash. So the memberships are counted first, with no other table in the join to mislead the estimate, the lists are
-- matched afterwards, and nested loops and merge joins are off for this transaction; 64 MB keeps the hash in memory.
-- Expect 10 to 30 s on production at 1,800,000 memberships, reading only.
SET LOCAL enable_nestloop = off;
SET LOCAL enable_mergejoin = off;
SET LOCAL work_mem = '64MB';
INSERT INTO audience_list_counts (workspace_id, list_id, subscribed, unsubscribed, unknown, suppressed)
WITH counted AS MATERIALIZED (
  SELECT m.workspace_id, m.list_id, count(*) FILTER (WHERE NOT c.suppressed AND c.marketing_consent = 'subscribed') AS subscribed, count(*) FILTER (WHERE NOT c.suppressed AND c.marketing_consent = 'unsubscribed') AS unsubscribed,
    count(*) FILTER (WHERE NOT c.suppressed AND c.marketing_consent = 'unknown') AS unknown, count(*) FILTER (WHERE c.suppressed) AS suppressed
  FROM audience_list_members m JOIN audience_contacts c ON c.workspace_id = m.workspace_id AND c.id = m.contact_id
  WHERE c.deleted_at IS NULL GROUP BY 1, 2
)
SELECT workspace_id, list_id, sum(subscribed), sum(unsubscribed), sum(unknown), sum(suppressed) FROM (
  SELECT n.* FROM counted n WHERE EXISTS (SELECT FROM audience_lists l WHERE l.workspace_id = n.workspace_id AND l.id = n.list_id)
  UNION ALL SELECT workspace_id, list_id, -subscribed, -unsubscribed, -unknown, -suppressed FROM audience_list_counts
) difference GROUP BY 1, 2 HAVING sum(subscribed) <> 0 OR sum(unsubscribed) <> 0 OR sum(unknown) <> 0 OR sum(suppressed) <> 0;
